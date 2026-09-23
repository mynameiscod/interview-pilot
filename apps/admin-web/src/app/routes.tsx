import type { RouteObject } from 'react-router';
import { AdminLayout } from './AdminLayout';

function RouteLoading() {
  return (
    <div className="p-5 d-flex justify-content-center" role="status">
      <div className="spinner-border text-primary" aria-hidden="true" />
    </div>
  );
}

export const routes: RouteObject[] = [
  {
    element: <AdminLayout />,
    HydrateFallback: RouteLoading,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('../pages/DashboardPage')).DashboardPage }),
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('../pages/NotFoundPage')).NotFoundPage }),
      },
    ],
  },
];
