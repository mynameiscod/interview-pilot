import '@cbi/design-system/styles.scss';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import { AuthProvider, createSessionManager, initBrowserErrorTracking } from '@cbi/web-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './app/routes';
import { loadAdminUser } from './app/session';
import { OrgManagerProvider } from './org/guards';
import { config } from './config';
import { initI18n } from './i18n';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

async function bootstrap() {
  // Off unless VITE_SENTRY_DSN was set at build time; the SDK chunk is loaded only then.
  void initBrowserErrorTracking(
    {
      dsn: config.sentryDsn,
      environment: config.appEnv,
      release: config.sentryRelease,
      app: 'admin',
    },
    () => import('@sentry/react'),
  );
  const i18n = await initI18n();
  const manager = createSessionManager({ baseUrl: config.apiUrl, audience: 'admin' });
  // The org portal (/org) keeps its own session: a separate audience, cookie and tab channel.
  const orgManager = createSessionManager({ baseUrl: config.apiUrl, audience: 'org' });
  const router = createBrowserRouter(routes);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider manager={manager} loadUser={loadAdminUser}>
            <OrgManagerProvider manager={orgManager}>
              <RouterProvider router={router} />
            </OrgManagerProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void bootstrap();
