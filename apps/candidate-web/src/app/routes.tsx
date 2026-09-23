import type { RouteObject } from 'react-router';
import { PublicLayout } from './PublicLayout';
import { RouteError, RouteLoading } from './RouteStates';

/**
 * Route table. Pages are lazy-loaded so each route ships as its own chunk;
 * heavy features (Monaco, charts, media) stay out of the landing bundle.
 */
export const routes: RouteObject[] = [
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
        path: '*',
        lazy: async () => ({ Component: (await import('../pages/NotFoundPage')).NotFoundPage }),
      },
    ],
  },
];
