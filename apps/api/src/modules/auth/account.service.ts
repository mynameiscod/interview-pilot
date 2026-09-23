import { maskEmail, maskMobile } from '@cbi/auth-core';
import {
  AuthIdentityModel,
  mongoose,
  UserModel,
  UserProfileModel,
  type UserDocument,
} from '@cbi/db';
import type {
  AdminRole,
  IdentityProvider,
  MeResponse,
  OtpChannel,
  SessionAudience,
  UserStatus,
} from '@cbi/shared-types';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import type { GoogleIdentityClaims } from './google-verifier.js';

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/** Runs `fn` in a transaction, retrying once on a unique-index race. */
async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } catch (err) {
      if (attempt === 0 && isDuplicateKey(err)) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

const contactField = (channel: OtpChannel) =>
  channel === 'EMAIL'
    ? ({ contact: 'primaryEmail', verified: 'emailVerifiedAt' } as const)
    : ({ contact: 'primaryMobile', verified: 'mobileVerifiedAt' } as const);

function assertCanSignIn(user: UserDocument, audience: SessionAudience) {
  if (user.status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
  }
  if (audience === 'admin' && user.adminRoles.length === 0) {
    throw AppError.forbidden('This account does not have admin access.');
  }
}

export function createAccountService() {
  /** Finds the user who owns a contact: via a verified identity first, then the primary contact. */
  async function findUserByContact(
    channel: OtpChannel,
    destination: string,
    session?: ClientSession,
  ): Promise<UserDocument | null> {
    const identity = await AuthIdentityModel.findOne(
      { provider: channel, subject: destination },
      null,
      { session },
    );
    if (identity) return UserModel.findById(identity.userId, null, { session });
    const { contact } = contactField(channel);
    return UserModel.findOne({ [contact]: destination }, null, { session });
  }

  async function attachIdentity(
    user: UserDocument,
    provider: IdentityProvider,
    subject: string,
    session: ClientSession,
    extra: { email?: string } = {},
  ) {
    const now = new Date();
    await AuthIdentityModel.create(
      [{ userId: user._id, provider, subject, verifiedAt: now, ...extra }],
      { session },
    );
    if (provider === 'EMAIL' || provider === 'MOBILE') {
      const { contact, verified } = contactField(provider);
      if (!user[contact]) user[contact] = subject;
      if (user[contact] === subject && !user[verified]) user[verified] = now;
    }
  }

  async function markLogin(user: UserDocument, session: ClientSession) {
    user.lastLoginAt = new Date();
    await user.save({ session });
  }

  return {
    findUserByContact,

    /** Deliverability check for admin OTP: only existing, active admins receive codes. */
    async findActiveAdminByContact(channel: OtpChannel, destination: string) {
      const user = await findUserByContact(channel, destination);
      return user && user.status === 'ACTIVE' && user.adminRoles.length > 0 ? user : null;
    },

    /**
     * Signs in with an email/mobile the person just proved they own. Creates the
     * account on first candidate sign-in; never creates admin accounts.
     */
    loginWithVerifiedContact(
      channel: OtpChannel,
      destination: string,
      audience: SessionAudience,
    ): Promise<{ user: UserDocument; created: boolean }> {
      return inTransaction(async (session) => {
        let user = await findUserByContact(channel, destination, session);
        let created = false;
        if (!user) {
          if (audience === 'admin')
            throw AppError.forbidden('This account does not have admin access.');
          user = new UserModel({});
          await user.save({ session });
          await UserProfileModel.create([{ userId: user._id }], { session });
          created = true;
        }
        const hasIdentity = await AuthIdentityModel.exists({
          provider: channel,
          subject: destination,
        }).session(session);
        if (!hasIdentity) await attachIdentity(user!, channel, destination, session);
        assertCanSignIn(user!, audience);
        await markLogin(user!, session);
        return { user: user!, created };
      });
    },

    /**
     * Google sign-in. An existing account with the same verified email is
     * reused (the Google identity is linked to it) instead of creating a duplicate.
     */
    loginWithGoogle(
      claims: GoogleIdentityClaims,
      audience: SessionAudience,
    ): Promise<{ user: UserDocument; created: boolean }> {
      return inTransaction(async (session) => {
        const identity = await AuthIdentityModel.findOne(
          { provider: 'GOOGLE', subject: claims.sub },
          null,
          { session },
        );
        let user = identity ? await UserModel.findById(identity.userId, null, { session }) : null;
        let created = false;
        if (!user) {
          user = await findUserByContact('EMAIL', claims.email, session);
          if (!user) {
            if (audience === 'admin')
              throw AppError.forbidden('This account does not have admin access.');
            user = new UserModel({});
            await user.save({ session });
            await UserProfileModel.create(
              [{ userId: user._id, displayName: claims.name?.slice(0, 80) }],
              { session },
            );
            created = true;
          }
          await attachIdentity(user!, 'GOOGLE', claims.sub, session, { email: claims.email });
          const hasEmail = await AuthIdentityModel.exists({
            provider: 'EMAIL',
            subject: claims.email,
          }).session(session);
          if (!hasEmail) await attachIdentity(user!, 'EMAIL', claims.email, session);
        }
        assertCanSignIn(user!, audience);
        await markLogin(user!, session);
        return { user: user!, created };
      });
    },

    /** Adds a verified email/mobile/Google identity to the signed-in user. */
    linkIdentity(
      userId: string,
      provider: IdentityProvider,
      subject: string,
      extra: { email?: string } = {},
    ): Promise<void> {
      return inTransaction(async (session) => {
        const existing = await AuthIdentityModel.findOne({ provider, subject }, null, { session });
        if (existing) {
          if (String(existing.userId) === userId) return;
          throw new AppError(409, 'IDENTITY_IN_USE', 'This is already linked to another account.');
        }
        if (provider !== 'GOOGLE') {
          const { contact } = contactField(provider);
          const owner = await UserModel.findOne({ [contact]: subject }, { _id: 1 }, { session });
          if (owner && String(owner._id) !== userId) {
            throw new AppError(
              409,
              'IDENTITY_IN_USE',
              'This is already linked to another account.',
            );
          }
        }
        const user = await UserModel.findById(userId, null, { session });
        if (!user) throw AppError.unauthenticated();
        await attachIdentity(user, provider, subject, session, extra);
        await user.save({ session });
      });
    },

    async loadMe(userId: string): Promise<MeResponse> {
      const [user, profile, identities] = await Promise.all([
        UserModel.findById(userId).lean(),
        UserProfileModel.findOne({ userId }).lean(),
        AuthIdentityModel.find({ userId }).sort({ createdAt: 1 }).lean(),
      ]);
      if (!user) throw AppError.unauthenticated();
      return {
        id: String(user._id),
        email: user.emailVerifiedAt ? (user.primaryEmail ?? null) : null,
        mobile: user.mobileVerifiedAt ? (user.primaryMobile ?? null) : null,
        status: user.status as UserStatus,
        adminRoles: user.adminRoles as AdminRole[],
        onboardingCompleted: Boolean(user.onboardingCompletedAt),
        profile: {
          displayName: profile?.displayName ?? null,
          preferredInterviewLanguage: profile?.preferredInterviewLanguage ?? 'auto',
          experienceLevel: profile?.experienceLevel ?? null,
          currentRole: profile?.currentRole ?? null,
          productUpdatesOptIn: profile?.productUpdatesOptIn ?? false,
        },
        identities: identities.map((i) => ({
          provider: i.provider as IdentityProvider,
          display:
            i.provider === 'EMAIL'
              ? maskEmail(i.subject)
              : i.provider === 'MOBILE'
                ? maskMobile(i.subject)
                : i.email
                  ? maskEmail(i.email)
                  : 'Google account',
          verifiedAt: i.verifiedAt.toISOString(),
        })),
        createdAt: user.createdAt.toISOString(),
      };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
