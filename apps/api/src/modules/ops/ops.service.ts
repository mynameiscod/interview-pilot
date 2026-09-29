import { createHash } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  FeatureFlagModel,
  type Redis,
  SystemSettingModel,
  type FeatureFlagRecord,
  type SystemSettingRecord,
} from '@cbi/db';
import {
  DEFAULT_SETTINGS,
  SystemSettings,
  type ClientFlags,
  type FeatureFlag,
  type KnownFlag,
  type SettingEntry,
  type SettingKey,
  type UpdateFlagBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

/**
 * Flags and settings are read on hot paths, so each process caches them.
 * Admin changes are broadcast on OPS_CONFIG_CHANNEL and every API process
 * drops its copy at once; the TTL is the fallback if a message is missed.
 */
const CACHE_MS = 15_000;

/** Redis pub/sub channel: a feature flag or system setting changed. */
export const OPS_CONFIG_CHANNEL = 'cbi:ops:config-changed' as const;

type PubSubRedis = Pick<Redis, 'publish' | 'duplicate'>;

/**
 * Cache-bust plumbing shared by the flag and settings services (the same
 * pattern as the AI config and integrations channels). `redis: null` keeps
 * invalidation local (unit tests).
 */
export function createOpsChangeBus(deps: { redis: PubSubRedis | null; logger?: Logger }) {
  const listeners = new Set<() => void>();
  function invalidateLocal() {
    for (const fn of listeners) fn();
  }
  return {
    /** Registers a cache to drop on every change (here or in another process). */
    onChange(fn: () => void) {
      listeners.add(fn);
    },
    invalidateLocal,
    /** Drop caches here and tell every other process to do the same. */
    async announceChange() {
      invalidateLocal();
      if (!deps.redis) return;
      try {
        await deps.redis.publish(OPS_CONFIG_CHANNEL, String(Date.now()));
      } catch (err) {
        // Other processes still pick the change up within CACHE_MS.
        deps.logger?.warn({ err }, 'flag/setting change broadcast failed');
      }
    },
    /** Subscribes on a dedicated connection; returns a function that unsubscribes. */
    async listenForChanges(): Promise<() => Promise<void>> {
      if (!deps.redis) return async () => undefined;
      const subscriber = deps.redis.duplicate();
      await subscriber.connect();
      await subscriber.subscribe(OPS_CONFIG_CHANNEL);
      subscriber.on('message', (channel: string) => {
        if (channel === OPS_CONFIG_CHANNEL) invalidateLocal();
      });
      return async () => {
        await subscriber.quit().catch(() => undefined);
      };
    },
  };
}

export type OpsChangeBus = ReturnType<typeof createOpsChangeBus>;

/**
 * A TTL cache for one query. `invalidate` also discards a load that was
 * already running, so a read that raced an admin change is not kept.
 */
export function createTtlCache<T>(load: () => Promise<T>, ttlMs: number, now: () => number) {
  let cache: { at: number; value: T } | null = null;
  let generation = 0;
  return {
    async get(): Promise<T> {
      if (cache && now() - cache.at <= ttlMs) return cache.value;
      const started = generation;
      const at = now();
      const value = await load();
      if (started === generation) cache = { at, value };
      return value;
    },
    invalidate() {
      generation += 1;
      cache = null;
    },
  };
}

const flagSummary = (f: FeatureFlagRecord): FeatureFlag => ({
  key: f.key,
  description: f.description,
  enabled: f.enabled,
  rolloutPercent: f.rolloutPercent,
  clientVisible: f.clientVisible,
  updatedAt: iso(f.updatedAt),
  updatedBy: f.updatedBy ? String(f.updatedBy) : null,
});

/** Stable bucket 0–99 for a user and flag, so a rollout does not flip between requests. */
export function rolloutBucket(key: string, userId: string): number {
  return createHash('sha256').update(`${key}:${userId}`).digest().readUInt32BE(0) % 100;
}

export function flagOn(
  flag: Pick<FeatureFlagRecord, 'key' | 'enabled' | 'rolloutPercent'>,
  userId: string | null,
): boolean {
  if (!flag.enabled) return false;
  if (flag.rolloutPercent >= 100) return true;
  // Partial rollouts apply to signed-in users only.
  return userId !== null && rolloutBucket(flag.key, userId) < flag.rolloutPercent;
}

export function createFlagService(deps: {
  audit: AuditService;
  changes?: OpsChangeBus;
  now?: () => number;
}) {
  const changes = deps.changes ?? createOpsChangeBus({ redis: null });
  const cache = createTtlCache(
    () => FeatureFlagModel.find().sort({ key: 1 }).lean<FeatureFlagRecord[]>(),
    CACHE_MS,
    deps.now ?? Date.now,
  );
  changes.onChange(() => cache.invalidate());
  const all = () => cache.get();
  return {
    /** Whether a flag is on for this user (off when unknown). */
    async isEnabled(key: KnownFlag, userId: string | null) {
      const flag = (await all()).find((f) => f.key === key);
      return flag ? flagOn(flag, userId) : false;
    },
    /** Whether the flag is switched on at all (for public pages with no user). */
    async isSwitchedOn(key: KnownFlag) {
      return Boolean((await all()).find((f) => f.key === key)?.enabled);
    },
    async clientFlags(userId: string | null): Promise<ClientFlags> {
      return Object.fromEntries(
        (await all()).filter((f) => f.clientVisible).map((f) => [f.key, flagOn(f, userId)]),
      );
    },
    async list(): Promise<FeatureFlag[]> {
      return (await FeatureFlagModel.find().sort({ key: 1 }).lean()).map(flagSummary);
    },
    async update(key: string, body: UpdateFlagBody, actorId: string, ctx: ClientContext) {
      const updated = await transaction(async (tx) => {
        const before = await FeatureFlagModel.findOne({ key }, null, { session: tx }).lean();
        if (!before) throw AppError.notFound('Feature flag not found');
        const after = await FeatureFlagModel.findOneAndUpdate(
          { key },
          {
            $set: {
              enabled: body.enabled,
              rolloutPercent: body.rolloutPercent,
              updatedBy: actorId,
            },
          },
          { returnDocument: 'after', session: tx },
        ).lean();
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'flag.updated',
            resourceType: 'featureFlag',
            resourceId: key,
            details: {
              before: { enabled: before.enabled, rolloutPercent: before.rolloutPercent },
              after: { enabled: body.enabled, rolloutPercent: body.rolloutPercent },
              reason: body.reason,
            },
          },
          ctx,
          tx,
        );
        return after!;
      });
      await changes.announceChange();
      return flagSummary(updated);
    },
    /** Tests: forget cached flags. */
    invalidate() {
      cache.invalidate();
    },
  };
}

export type FlagService = ReturnType<typeof createFlagService>;

export function createSettingsService(deps: {
  audit: AuditService;
  changes?: OpsChangeBus;
  now?: () => number;
}) {
  const changes = deps.changes ?? createOpsChangeBus({ redis: null });
  const cache = createTtlCache(
    () => SystemSettingModel.find().lean<SystemSettingRecord[]>(),
    CACHE_MS,
    deps.now ?? Date.now,
  );
  changes.onChange(() => cache.invalidate());
  const rows = () => cache.get();
  /** The stored value if it is valid, else the default (a bad row never breaks callers). */
  function valueOf<K extends SettingKey>(key: K, row: SystemSettingRecord | undefined) {
    const parsed = SystemSettings.shape[key].safeParse(row?.value);
    return (parsed.success ? parsed.data : DEFAULT_SETTINGS[key]) as SystemSettings[K];
  }
  return {
    async get<K extends SettingKey>(key: K): Promise<SystemSettings[K]> {
      return valueOf(
        key,
        (await rows()).find((r) => r.key === key),
      );
    },
    async list(): Promise<SettingEntry[]> {
      const stored = await SystemSettingModel.find().lean();
      return SystemSettings.keyof().options.map((key) => {
        const row = stored.find((r) => r.key === key);
        return {
          key,
          value: valueOf(key, row),
          updatedAt: row ? iso(row.updatedAt) : null,
          updatedBy: row?.updatedBy ? String(row.updatedBy) : null,
        };
      });
    },
    async update(
      key: SettingKey,
      value: unknown,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ) {
      const parsed = SystemSettings.shape[key].safeParse(value);
      if (!parsed.success) {
        throw AppError.validation('Invalid setting value', parsed.error.issues);
      }
      await transaction(async (tx) => {
        const before = await SystemSettingModel.findOne({ key }, null, { session: tx }).lean();
        await SystemSettingModel.updateOne(
          { key },
          { $set: { value: parsed.data, updatedBy: actorId } },
          { upsert: true, session: tx },
        );
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'setting.updated',
            resourceType: 'systemSetting',
            resourceId: key,
            details: { before: valueOf(key, before ?? undefined), after: parsed.data, reason },
          },
          ctx,
          tx,
        );
      });
      await changes.announceChange();
      return (await this.list()).find((e) => e.key === key)!;
    },
    invalidate() {
      cache.invalidate();
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
