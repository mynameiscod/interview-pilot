import type { RouteObject } from 'react-router';
import { FocusLayout } from './FocusLayout';
import { RedirectIfSignedIn, RequireAuth, RequireOnboarded } from './guards';
import { PublicLayout } from './PublicLayout';
import { RouteError, RouteLoading } from './RouteStates';

/**
 * Route table. Pages are lazy-loaded so each route ships as its own chunk;
 * heavy features (Monaco, charts, media) stay out of the landing bundle.
 */
export const routes: RouteObject[] = [
  {
    // The interview room uses a focus layout without the main navigation.
    element: <FocusLayout />,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteLoading,
    children: [
      {
        element: <RequireAuth />,
        children: [
          {
            element: <RequireOnboarded />,
            children: [
              {
                path: 'app/interviews/:id/room',
                lazy: async () => ({
                  Component: (await import('../features/room/RoomPage')).RoomPage,
                }),
              },
            ],
          },
        ],
      },
    ],
  },
  {
    element: <PublicLayout />,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteLoading,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('../pages/LandingPage')).LandingPage }),
      },
      {
        path: 'pricing',
        lazy: async () => ({
          Component: (await import('../features/payments/PricingPage')).PricingPage,
        }),
      },
      {
        // Company invite links: public, so candidates see the interview before signing in.
        path: 'campaign/:token',
        lazy: async () => ({
          Component: (await import('../features/campaigns/CampaignPage')).CampaignPage,
        }),
      },
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
        element: <RequireAuth />,
        children: [
          {
            path: 'onboarding',
            lazy: async () => ({
              Component: (await import('../features/profile/OnboardingPage')).OnboardingPage,
            }),
          },
          {
            path: 'app',
            element: <RequireOnboarded />,
            children: [
              {
                index: true,
                lazy: async () => ({
                  Component: (await import('../features/dashboard/DashboardPage')).DashboardPage,
                }),
              },
              {
                path: 'profile',
                lazy: async () => ({
                  Component: (await import('../features/profile/ProfilePage')).ProfilePage,
                }),
              },
              {
                path: 'new',
                lazy: async () => ({
                  Component: (await import('../features/interviews/wizard/NewInterviewPage'))
                    .NewInterviewPage,
                }),
              },
              {
                path: 'interviews/:id/analysis',
                lazy: async () => ({
                  Component: (await import('../features/interviews/AnalysisPage')).AnalysisPage,
                }),
              },
              {
                path: 'interviews/:id/setup',
                lazy: async () => ({
                  Component: (await import('../features/interviews/SetupPage')).SetupPage,
                }),
              },
              {
                // Voice and video interviews: camera, microphone, speaker and connection checks, then consent.
                path: 'interviews/:id/device-check',
                lazy: async () => ({
                  Component: (await import('../features/voice/DeviceCheckPage')).DeviceCheckPage,
                }),
              },
              {
                // Consents the interview asks for (voice processing, recording, session observations).
                path: 'interviews/:id/consent',
                lazy: async () => ({
                  Component: (await import('../features/consent/ConsentPage')).ConsentPage,
                }),
              },
              {
                path: 'interviews/:id/start',
                lazy: async () => ({
                  Component: (await import('../features/interviews/StartPage')).StartPage,
                }),
              },
              {
                path: 'interviews/:id/complete',
                lazy: async () => ({
                  Component: (await import('../features/interviews/CompletePage')).CompletePage,
                }),
              },
              {
                path: 'reports/:id',
                lazy: async () => ({
                  Component: (await import('../features/reports/ReportPage')).ReportPage,
                }),
              },
              {
                path: 'history',
                lazy: async () => ({
                  Component: (await import('../features/reports/HistoryPage')).HistoryPage,
                }),
              },
              {
                path: 'compare',
                lazy: async () => ({
                  Component: (await import('../features/reports/ComparePage')).ComparePage,
                }),
              },
              {
                path: 'checkout/:planCode',
                lazy: async () => ({
                  Component: (await import('../features/payments/CheckoutPage')).CheckoutPage,
                }),
              },
              {
                path: 'payments/:purchaseId',
                lazy: async () => ({
                  Component: (await import('../features/payments/PaymentStatusPage'))
                    .PaymentStatusPage,
                }),
              },
              {
                path: 'purchases',
                lazy: async () => ({
                  Component: (await import('../features/payments/PurchasesPage')).PurchasesPage,
                }),
              },
            ],
          },
        ],
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('../pages/NotFoundPage')).NotFoundPage }),
      },
    ],
  },
];
