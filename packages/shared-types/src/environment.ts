import { z } from 'zod';

export const AppEnv = z.enum(['development', 'test', 'staging', 'production']);
export type AppEnv = z.infer<typeof AppEnv>;
