import '@cbi/design-system/styles.scss';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './app/routes';
import { UnsupportedBrowser } from './components/UnsupportedBrowser';
import { config } from './config';
import { initI18n } from './i18n';
import { browserDoNotTrack, fetchSender, initAnalytics, safeLocalStorage } from './lib/analytics';
import { detectMissingFeatures } from './lib/browser-support';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

async function bootstrap() {
  const i18n = await initI18n();
  const supported = detectMissingFeatures().length === 0;
  const root = createRoot(document.getElementById('root')!);

  if (!supported) {
    root.render(
      <I18nextProvider i18n={i18n}>
        <UnsupportedBrowser />
      </I18nextProvider>,
    );
    return;
  }

  // The access token lives only in this object's memory; the refresh token
  // is an httpOnly cookie the page cannot read.
  const manager = createSessionManager({ baseUrl: config.VITE_API_URL, audience: 'candidate' });
  const router = createBrowserRouter(routes);

  // Product analytics: route patterns and a few non-personal props only; off with Do Not Track.
  initAnalytics({
    send: fetchSender(config.VITE_API_URL, () => manager.current?.accessToken),
    storage: safeLocalStorage(),
    doNotTrack: browserDoNotTrack(),
    target: window,
  });

  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider manager={manager}>
            <RouterProvider router={router} />
          </AuthProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void bootstrap();
