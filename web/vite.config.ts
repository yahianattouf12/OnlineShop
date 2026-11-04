import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development (npm run dev) the browser talks to Vite on :5173, and Vite forwards /api to the API.
// In Docker, nginx does the same forwarding (see nginx.conf), so the app never needs CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/swagger': 'http://localhost:8080',
      '/openapi': 'http://localhost:8080',
    },
  },
});
