import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { CartProvider } from './cart/CartContext';
import { ToastProvider } from './components/Toasts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
