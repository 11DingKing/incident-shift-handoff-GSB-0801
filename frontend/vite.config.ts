import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend runs on :8080 by default; override with VITE_API_PORT if needed.
const apiPort = process.env.VITE_API_PORT ?? '8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
