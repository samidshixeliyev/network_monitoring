import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Where the dev server proxies /api, /ws, /tiles. On the host `npm run dev` this
// is the published API port (localhost:8000); inside the frontend container the
// API is reachable by its compose service name, so set VITE_PROXY_TARGET=http://api:8000.
const apiTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:8000'
const wsTarget = apiTarget.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: wsTarget,
        ws: true,
      },
      // Offline basemap tiles served by the API (backend/tiles/...)
      '/tiles': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
