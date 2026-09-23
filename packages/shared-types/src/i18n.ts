import { z } from 'zod';

/**
 * UI locales shipped with the web apps. Interview languages are a separate,
 * admin-managed list driven by provider capabilities (see docs/architecture).
 */
export const UiLocale = z.enum(['en', 'te', 'hi']);
export type UiLocale = z.infer<typeof UiLocale>;

export const DEFAULT_UI_LOCALE: UiLocale = 'en';
