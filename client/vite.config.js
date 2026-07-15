import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client talks to the API at /api. In dev, proxy that to the Express
// server on :4000 so everything is same-origin from the browser's point of view.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
