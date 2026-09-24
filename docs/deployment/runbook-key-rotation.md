# Runbook: key and secret rotation

Where secrets live: `/srv/cbi/.env.<env>` (API + worker), `/srv/cbi/.env.datastores` (Mongo/Redis), `/srv/cbi/.env.backup`, `/srv/cbi/secrets/mongo-keyfile`, GitHub environment secrets, and the age identity (offline). They never go in the repository or in images.

**Applying an env change:** containers read env files only when they are created. Redeploy the current tag:

```bash
TAG=$(grep ^CURRENT_TAG= /srv/cbi/state/deploy.state | cut -d= -f2)
/srv/cbi/app/infrastructure/scripts/deploy.sh "$TAG"
```

The idle colour starts with the new values and has to pass `/readyz` before it receives traffic. Then the old colour drains and the workers are recreated. For about a minute the old processes still run with the old value; each section below says what that means.

Schedule: rotate yearly, whenever someone with access leaves, and immediately after any suspected leak. Record every rotation (what, when, who) in the ops log. Never paste secrets into tickets or chat.

## JWT_ACCESS_SECRET

Signs access tokens (10-minute TTL). There is only one key, with no overlap.

1. Generate a new value with `openssl rand -base64 48`. It must differ from `OTP_HMAC_SECRET`.
2. Edit `.env.<env>` and redeploy the current tag.
3. **Effect:** access tokens signed with the old key fail on the new colour. The web apps refresh silently (refresh tokens are stored hashed in Mongo, not signed with this key), so users see at most one extra round trip. During the swap window a request can briefly land on the old colour and fail; the clients retry.
4. To also **sign everyone out** (compromise), revoke sessions too: Admin → Admins → revoke for admins. For all users, run a `tokenVersion` bump through mongosh as root, for example `db.users.updateMany({}, {$inc: {tokenVersion: 1}})`. Live sessions pick it up once the 60 s user-state cache entry expires. Record the action in the ops log.

## OTP_HMAC_SECRET

This key is used for:

- OTP code hashes and OTP rate-limit keys
- pseudonymous IP and destination hashes in `auditLogs`, `consents` and `refreshTokens`
- the signing key for short-lived media playback links

1. Generate a new value with `openssl rand -base64 48`, edit the env file and redeploy.
2. **Effects:**
   - Codes that are outstanding stop working, so users request a new one.
   - Per-destination OTP counters reset.
   - Playback links already issued stop working, so players request new ones.
   - Hashes made before the rotation no longer match hashes made after it, so IP correlation across the rotation date is lost. Note the date in the ops log.

## AI_SECRETS_MASTER_KEY (AI provider keys at rest)

Provider API keys entered in Admin are stored AES-256-GCM encrypted with this key ([provider-layer.md](../ai/provider-layer.md#provider-keys)). The API and the worker both decrypt them.

1. Generate a new key with `openssl rand -base64 32`.
2. In `.env.<env>`:
   - set `AI_SECRETS_MASTER_KEY=<new>`
   - set `AI_SECRETS_KEY_ID` to a new id (for example `k1` → `k2`)
   - set `AI_SECRETS_PREVIOUS_KEYS=k1:<old key>`, appending if entries already exist
3. Turn on maintenance mode (optional, but recommended), then redeploy the current tag. At boot the new API colour re-encrypts every stored provider key with the new master key (once, even with several replicas) and writes `ai.provider_credential_rotated` to the audit log.
4. **Window:** until the old colour and old workers are gone (about a minute), old processes can't decrypt rows already re-encrypted with the new key. The router skips those providers, so AI calls in that minute may fail over or fail. Retry any failed jobs from Admin → System → Queues.
5. Once the audit log shows every provider rotated, remove the old entry from `AI_SECRETS_PREVIOUS_KEYS` and redeploy again.
6. Keep the old key in the password manager until the next backup rotation cycle (4 weeks). Backups taken before the rotation contain ciphertext made with it.

To rotate a **provider's own API key** (OpenAI, Anthropic, Gemini, Deepgram, ElevenLabs), create the new key in the provider console, enter it in Admin → AI providers → Providers & keys (`ai.manage`, with a reason; audited), check Admin → AI → Provider health, then revoke the old key in the provider console. No deploy is needed.

## Razorpay

**Webhook secret (`RAZORPAY_WEBHOOK_SECRET`):**

1. In the Razorpay dashboard → Webhooks, edit the webhook and set a new secret.
2. Put the same value in `.env.<env>` and redeploy immediately.
3. Webhooks signed with the new secret that arrive at the old colour during the swap get `400 Invalid webhook signature`. Razorpay retries them for 24 hours, and the hourly reconciliation job covers anything missed.

**API key (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`):** regenerate it in the dashboard (API Keys), update both values and redeploy. Orders created with the old key id may fail Checkout during the swap; users simply retry. Reconciliation confirms payments that were captured.

Use `rzp_test_…` keys on staging and `rzp_live_…` keys on production only.

## Judge (JUDGE_HMAC_SECRET, JUDGE0_AUTH_TOKEN)

Requests to the judge are signed with `JUDGE_HMAC_SECRET`, and the judge's verifying proxy must hold the same value ([coding.md](../architecture/coding.md)).

1. Configure the proxy to accept **both** the old and the new secret, if it supports that. Otherwise do the rotation in a quiet window with maintenance mode on.
2. Set the new value (at least 32 characters) in `.env.<env>` and redeploy.
3. Remove the old secret from the proxy.
4. Code runs during the gap return a judge error, and the candidate can resubmit.

## MongoDB passwords

**App user (`MONGO_APP_PASSWORD` / `MONGODB_URI`), zero downtime:** rotate by switching to a new user name, so the old and new credentials work at the same time.

1. In `.env.datastores`, set `MONGO_APP_USER=cbi_app_v2` (increment on each rotation) and a new `MONGO_APP_PASSWORD` (`openssl rand -hex 32`).
2. In `.env.<env>`, update `MONGODB_URI` to the new user and password.
3. Redeploy the current tag. `mongo-init` creates `cbi_app_v2`, the new colour and workers use it, and the old processes keep using the old user until they stop.
4. Afterwards, drop the old user:

   ```bash
   $DC exec mongo mongosh -u root -p --authenticationDatabase admin \
     --eval 'db.getSiblingDB("cbi_interview").dropUser("cbi_app")'
   ```

**Backup user (`MONGO_BACKUP_PASSWORD`):** change it in `.env.datastores`, then run `$DC run --rm --no-deps -T mongo-init`, which updates the password. The next backup reads the new value.

**Root (`MONGO_INITDB_ROOT_PASSWORD`):** the image uses this variable only on the very first start. Change the password live, then update the file to match:

```bash
$DC exec mongo mongosh -u root -p --authenticationDatabase admin --eval 'db.getSiblingDB("admin").changeUserPassword("root", passwordPrompt())'
sudo -e /srv/cbi/.env.datastores   # MONGO_INITDB_ROOT_PASSWORD=<new>
```

**Replica-set keyfile:** a single-node set only uses it for internal authentication, so rotate it only if it leaked. In a maintenance window, stop the api colours and workers, replace `/srv/cbi/secrets/mongo-keyfile` (`openssl rand -base64 756`, mode 0400), run `$DC up -d --no-deps --force-recreate mongo`, then redeploy.

## Redis password (zero downtime with ACL)

1. Generate a new password with `openssl rand -hex 32`.
2. Add it next to the old one, live (Redis allows several passwords per user):

   ```bash
   $DC exec redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli ACL SETUSER default ">NEW_PASSWORD"'
   ```

3. Update `REDIS_URL` in `.env.<env>` and `REDIS_PASSWORD` in `.env.datastores`, then redeploy the current tag.
4. Remove the old password: `redis-cli ACL SETUSER default "<OLD_PASSWORD"`, authenticated with the new one.
5. When Redis next restarts, `--requirepass` from `.env.datastores` applies the new value.

## Other credentials

| Secret                                    | How                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUNNY_STORAGE_ACCESS_KEY` (uploads)      | Bunny → Storage zone → FTP & API access → reset the password, update the env file and redeploy right away. Uploads fail on old processes until the swap ends.                                       |
| `BUNNY_BACKUP_ACCESS_KEY` / read-only key | Reset in Bunny, update `.env.backup` on production and the drill config on the drill host. No redeploy needed.                                                                                      |
| `SES_*` / `SMTP_*`                        | Create a new IAM access key (or SMTP credential), update and redeploy, check that a sign-in code arrives, then delete the old key.                                                                  |
| `MSG91_AUTH_KEY`                          | Regenerate in MSG91, update and redeploy, then test a mobile OTP.                                                                                                                                   |
| `GOOGLE_CLIENT_ID`                        | Not secret. Changing it also needs a web image rebuild (`VITE_GOOGLE_CLIENT_ID` repository variable), so tag a release.                                                                             |
| Backup age key                            | Create a new key pair, then **add** the new public key to `age-recipients.txt`. Keep the old identity until the last archive encrypted to it has aged out (4 weeks), then remove the old recipient. |
| TLS certificates                          | Automatic (certbot). To replace the account or key: `certs.sh issue --env <env> --email …`.                                                                                                         |
| CI deploy key (`SSH_PRIVATE_KEY`)         | Generate a new ed25519 key and append its public key to `~deploy/.ssh/authorized_keys`. Update the GitHub environment secret, run a deploy, then remove the old public key.                         |
| `SSH_KNOWN_HOSTS`                         | Update it only when the host key changes (new server), and verify the fingerprint out of band.                                                                                                      |
| `GHCR_PULL_TOKEN`                         | Create a new fine-grained PAT with `read:packages`, update the secret, then revoke the old one.                                                                                                     |
| `STAGING_BASIC_AUTH`                      | `sudo htpasswd -B /srv/cbi/nginx/htpasswd <user>`, reload NGINX and update the GitHub secret.                                                                                                       |
