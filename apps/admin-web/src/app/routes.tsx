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
                path: 'roles',
                element: <RequirePermission permission="library.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/library/RolesPage')).RolesPage,
                    }),
                  },
                  {
                    path: ':roleId',
                    lazy: async () => ({
                      Component: (await import('../features/library/RoleDetailPage'))
                        .RoleDetailPage,
                    }),
                  },
                ],
              },
              {
                path: 'blueprints',
                element: <RequirePermission permission="library.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/library/AiBlueprintsPage'))
                        .AiBlueprintsPage,
                    }),
                  },
                  {
                    path: ':blueprintId',
                    lazy: async () => ({
                      Component: (await import('../features/library/AiBlueprintsPage'))
                        .AiBlueprintPage,
                    }),
                  },
                ],
              },
              {
                path: 'companies',
                element: <RequirePermission permission="library.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/library/CompaniesPage')).CompaniesPage,
                    }),
                  },
                ],
              },
              {
                path: 'templates',
                element: <RequirePermission permission="library.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/library/TemplatesPage')).TemplatesPage,
                    }),
                  },
                ],
              },
              {
                path: 'problems',
                element: <RequirePermission permission="library.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/library/ProblemsPage')).ProblemsPage,
                    }),
                  },
                ],
              },
              {
                path: 'purchases',
                element: <RequirePermission permission="payments.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/payments/PurchasesPage')).PurchasesPage,
                    }),
                  },
                  {
                    path: ':purchaseId',
                    lazy: async () => ({
                      Component: (await import('../features/payments/PurchaseDetailPage'))
                        .PurchaseDetailPage,
                    }),
                  },
                ],
              },
              {
                path: 'plans',
                element: <RequirePermission permission="payments.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/payments/PlansPage')).PlansPage,
                    }),
                  },
                ],
              },
              {
                path: 'coupons',
                element: <RequirePermission permission="payments.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/payments/CouponsPage')).CouponsPage,
                    }),
                  },
                ],
              },
              {
                path: 'recordings',
                element: <RequirePermission permission="media.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/privacy/RecordingsPage'))
                        .RecordingsPage,
                    }),
                  },
                  {
                    path: ':mediaId',
                    lazy: async () => ({
                      Component: (await import('../features/privacy/RecordingDetailPage'))
                        .RecordingDetailPage,
                    }),
                  },
                ],
              },
              {
                path: 'consent-texts',
                element: <RequirePermission permission="consent.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/privacy/ConsentTextsPage'))
                        .ConsentTextsPage,
                    }),
                  },
                ],
              },
              {
                path: 'campaigns',
                element: <RequirePermission permission="campaigns.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/campaigns/CampaignsPage'))
                        .CampaignsPage,
                    }),
                  },
                  {
                    path: ':campaignId',
                    lazy: async () => ({
                      Component: (await import('../features/campaigns/CampaignDetailPage'))
                        .CampaignDetailPage,
                    }),
                  },
                ],
              },
              {
                path: 'interviews',
                element: <RequirePermission permission="interviews.read" />,
                children: [
                  {
                    index: true,
                    lazy: async () => ({
                      Component: (await import('../features/review/InterviewsPage')).InterviewsPage,
                    }),
                  },
                  {
                    path: ':interviewId',
                    lazy: async () => ({
                      Component: (await import('../features/review/InterviewDetailPage'))
                        .InterviewDetailPage,
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
