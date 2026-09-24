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
