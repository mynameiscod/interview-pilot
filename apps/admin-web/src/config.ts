const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AdminAppEnv = (typeof APP_ENVS)[number];

function parseAppEnv(value: string | undefined): AdminAppEnv {
  return (APP_ENVS as readonly string[]).includes(value ?? '')
    ? (value as AdminAppEnv)
    : 'development';
}

/** Public, build-time configuration. Never put secrets in VITE_* variables. */
export const config = {
  appEnv: parseAppEnv(import.meta.env.VITE_APP_ENV),
};
