import '@cbi/design-system/styles.scss';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './app/routes';
import { loadAdminUser } from './app/session';
import { config } from './config';
import { initI18n } from './i18n';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

async function bootstrap() {
  const i18n = await initI18n();
  const manager = createSessionManager({ baseUrl: config.apiUrl, audience: 'admin' });
  const router = createBrowserRouter(routes);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider manager={manager} loadUser={loadAdminUser}>
            <RouterProvider router={router} />
          </AuthProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void bootstrap();
