import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3100', changeOrigin: false } },
  },
  build: { outDir: '../dist', emptyOutDir: true },
})
