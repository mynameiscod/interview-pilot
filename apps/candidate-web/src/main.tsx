import '@cbi/design-system/styles.scss';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './app/routes';
import { UnsupportedBrowser } from './components/UnsupportedBrowser';
import { initI18n } from './i18n';
import { detectMissingFeatures } from './lib/browser-support';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

async function bootstrap() {
  const i18n = await initI18n();
  const supported = detectMissingFeatures().length === 0;
  const router = supported ? createBrowserRouter(routes) : null;

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          {router ? <RouterProvider router={router} /> : <UnsupportedBrowser />}
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void bootstrap();
