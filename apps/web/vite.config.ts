import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 开发环境代理到后端，避免 CORS 与硬编码地址
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
