import { z } from 'zod';
import { AppEnv } from './environment.js';

export const DependencyStatus = z.enum(['up', 'down']);
export type DependencyStatus = z.infer<typeof DependencyStatus>;

export const DependencyCheck = z.object({
  status: DependencyStatus,
  latencyMs: z.number().nonnegative().optional(),
  /** Short, non-sensitive reason when down. Never contains connection strings. */
  reason: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof DependencyCheck>;

export const LivenessResponse = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
});
export type LivenessResponse = z.infer<typeof LivenessResponse>;

export const ReadinessResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  env: AppEnv,
  checks: z.record(z.string(), DependencyCheck),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
