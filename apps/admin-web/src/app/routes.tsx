import type { RouteObject } from 'react-router';
import { AdminLayout } from './AdminLayout';
import { RedirectIfSignedIn, RequireAdmin, RequirePermission, RouteLoading } from './guards';

export const routes: RouteObject[] = [
  {
    HydrateFallback: RouteLoading,
    children: [
      {
        element: <RedirectIfSignedIn />,
        children: [
          {
            path: 'login',
            lazy: async () => ({
              Component: (await import('../features/auth/LoginPage')).LoginPage,
            }),
          },
        ],
      },
      {
        element: <RequireAdmin />,
        children: [
          {
            element: <AdminLayout />,
            children: [
              {
                index: true,
                lazy: async () => ({
                  Component: (await import('../pages/DashboardPage')).DashboardPage,
                }),
              },
              {
                path: 'admins',
                element: <RequirePermission permission="admin_users.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/admins/AdminUsersPage')).AdminUsersPage,
                    }),
                  },
                ],
              },
              {
                path: 'audit',
                element: <RequirePermission permission="audit.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/audit/AuditLogPage')).AuditLogPage,
                    }),
                  },
                ],
              },
              {
                path: 'ai',
                element: <RequirePermission permission="ai.read" />,
                children: [
                  {
                    lazy: async () => ({
                      Component: (await import('../features/ai/AiSectionLayout')).AiSectionLayout,
                    }),
                    children: [
                      {
                        index: true,
                        lazy: async () => ({
                          Component: (await import('../features/ai/ProvidersPage')).ProvidersPage,
                        }),
                      },
                      {
                        path: 'models',
                        lazy: async () => ({
                          Component: (await import('../features/ai/ModelsPage')).ModelsPage,
                        }),
                      },
                      {
                        path: 'routes',
                        lazy: async () => ({
                          Component: (await import('../features/ai/RoutesPage')).RoutesPage,
                        }),
                      },
                      {
                        path: 'health',
                        lazy: async () => ({
                          Component: (await import('../features/ai/HealthPage')).HealthPage,
                        }),
                      },
                    ],
                  },
                ],
              },
              {
                path: 'ai-usage',
                element: <RequirePermission permission="ai_usage.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/ai/UsagePage')).UsagePage,
                    }),
                  },
                ],
              },
              {
                path: 'prompts',
                element: <RequirePermission permission="prompts.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/prompts/PromptsPage')).PromptsPage,
                    }),
                  },
                ],
              },
              {
                path: '*',
                lazy: async () => ({
                  Component: (await import('../pages/NotFoundPage')).NotFoundPage,
                }),
              },
            ],
          },
        ],
      },
    ],
  },
];
