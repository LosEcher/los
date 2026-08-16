import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './hooks/useTheme';
import { ToastProvider } from './components/toast';
import { App } from './App';
import './styles/tokens.css';
import './styles.css';
import './markdown.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 8_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

// Offline shell / installability (G9): register the service worker only in
// production builds so dev servers and e2e never race against a stale cache.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal: the console works fully online without the worker.
    });
  });
}
