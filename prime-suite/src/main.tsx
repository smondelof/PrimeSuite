import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './session';
import { ToastProvider } from './components/ui';
import { DbGate } from './pages/DbSetup';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <DbGate>
          <SessionProvider>
            <App />
          </SessionProvider>
        </DbGate>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
);
