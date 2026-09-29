/**
 * Resets another admin's two-factor authentication (TOTP) when they have
 * lost both their authenticator and their recovery codes, and no super admin
 * can use the console action (Admin users → Reset 2FA).
 *
 *   pnpm --filter @cbi/api admin:reset-mfa --email ravi@codebegun.com \
 *     --operator ops@codebegun.com --reason "Lost phone, ticket #123"
 *   node dist/scripts/reset-admin-mfa.js --email … --operator … --reason …   (in the API container)
 *
 * The operator must be an active SUPER_ADMIN (checked in the database; the
 * real gate is shell access to the API container). The admin's factor and
 * recovery codes are removed, every session is ended (refresh tokens revoked,
 * tokenVersion bumped), and `admin.mfa_reset` is audited with the operator
 * and reason in the same transaction. Their next sign-in sets up a new
 * authenticator. Already-issued access tokens stop working once the API's
 * user-state cache (60 s) expires.
 */
import { parseArgs } from 'node:util';
import { AuditLogRetentionDays, createLogger } from '@cbi/config';
import { connectMongo, disconnectMongo, ensureIndexes } from '@cbi/db';
import { AppEnv } from '@cbi/shared-types';
import { z } from 'zod';
import { parseResetArgs, resetAdminMfaFromCli } from '../modules/admin/mfa-reset.js';

const env = z
  .object({
    APP_ENV: AppEnv,
    MONGODB_URI: z.string().min(1),
    AUDIT_LOG_RETENTION_DAYS: AuditLogRetentionDays,
  })
  .parse(process.env);
const logger = createLogger({ service: 'reset-admin-mfa', level: 'info', env: env.APP_ENV });

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    operator: { type: 'string' },
    reason: { type: 'string' },
  },
});
const input = parseResetArgs(values);
if ('error' in input) {
  logger.error(input.error);
  process.exit(2);
}

await connectMongo({ uri: env.MONGODB_URI, autoIndex: false, logger });
try {
  await ensureIndexes({ auditLogRetentionDays: env.AUDIT_LOG_RETENTION_DAYS });
  const result = await resetAdminMfaFromCli(input);
  if (!result.ok) {
    logger.error(result.error);
    process.exitCode = 1;
  } else {
    logger.info(
      { userId: result.targetId, sessionsEnded: result.sessionsEnded },
      '2FA reset; the admin sets up a new authenticator at their next sign-in',
    );
  }
} finally {
  await disconnectMongo();
}
