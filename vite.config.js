import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // three is ~600 kB on its own; splitting it out means a change to the UI
    // does not force everyone to re-download the renderer.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom']
        }
      }
    },
    chunkSizeWarningLimit: 900
  },
  server: {
    port: 5175,
    // Sketchfab sends no CORS headers for the search API when called from a
    // browser origin, and the token must not reach the client anyway. In dev
    // the same /api/sketchfab route the deployed function serves is proxied
    // straight through, so both environments speak the same protocol.
    proxy: {
      '/api/sketchfab': {
        target: 'https://api.sketchfab.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/sketchfab/, '/v3'),
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            const token = process.env.SKETCHFAB_TOKEN;
            if (token) proxyReq.setHeader('Authorization', `Token ${token}`);
          });
        }
      }
    }
  }
});
