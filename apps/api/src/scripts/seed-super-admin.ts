/**
 * Bootstraps the first SUPER_ADMIN (admins cannot self-register).
 *
 *   pnpm --filter @cbi/api admin:seed --email ops@codebegun.com
 *   node dist/scripts/seed-super-admin.js --email ops@codebegun.com   (in the API container)
 *
 * Idempotent: an existing account with that email gets SUPER_ADMIN added.
 * The person then signs in to the admin app with an email OTP, which proves
 * they control the address.
 */
import { parseArgs } from 'node:util';
import { normalizeEmail } from '@cbi/auth-core';
import { AppEnv } from '@cbi/shared-types';
import {
  AuditLogModel,
  AuthIdentityModel,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import { createLogger } from '@cbi/config';
import { z } from 'zod';

const env = z.object({ APP_ENV: AppEnv, MONGODB_URI: z.string().min(1) }).parse(process.env);
const logger = createLogger({ service: 'seed-super-admin', level: 'info', env: env.APP_ENV });

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const email = normalizeEmail(values.email ?? process.env.SEED_SUPER_ADMIN_EMAIL ?? '');
if (!email) {
  logger.error('Provide --email <address> or SEED_SUPER_ADMIN_EMAIL');
  process.exit(2);
}

await connectMongo({ uri: env.MONGODB_URI, autoIndex: false, logger });
try {
  await ensureIndexes();
  const identity = await AuthIdentityModel.findOne({ provider: 'EMAIL', subject: email });
  let user = identity
    ? await UserModel.findById(identity.userId)
    : await UserModel.findOne({ primaryEmail: email });
  if (!user) {
    user = await UserModel.create({ primaryEmail: email, adminRoles: ['SUPER_ADMIN'] });
    await UserProfileModel.create({ userId: user._id });
  } else if (!user.adminRoles.includes('SUPER_ADMIN')) {
    user.adminRoles = [...user.adminRoles, 'SUPER_ADMIN'];
    await user.save();
  }
  await AuditLogModel.create({
    actorType: 'SYSTEM',
    action: 'admin.super_admin_seeded',
    resourceType: 'user',
    resourceId: String(user._id),
    outcome: 'SUCCESS',
  });
  logger.info(
    { userId: String(user._id) },
    'super admin ready; sign in to the admin app with email OTP',
  );
} finally {
  await disconnectMongo();
}
