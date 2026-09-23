import { z } from 'zod';

export const UserType = z.enum(['CANDIDATE', 'ADMIN']);
export type UserType = z.infer<typeof UserType>;

export const AdminRole = z.enum([
  'SUPER_ADMIN',
  'OPERATIONS_ADMIN',
  'CONTENT_ADMIN',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
]);
export type AdminRole = z.infer<typeof AdminRole>;
