import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { AuthGate } from './auth.tsx';
import { Layout } from './layout.tsx';
import { I18nProvider } from './lib/i18n.tsx';
import { ThemeProvider } from './lib/theme.tsx';
import { ToastProvider } from './ui.tsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <AuthGate>
            <Layout>
              <App />
            </Layout>
          </AuthGate>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
