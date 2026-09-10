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
        changeOrigin: true,
        configure: (proxy) => {
          // tsx watch 热重启后端的几秒内前端轮询会 ECONNREFUSED，
          // 默认逐条打印堆栈非常吵，压成一行提示即可，后端起来后自动恢复
          proxy.on('error', (err, req) => {
            const url = typeof req?.url === 'string' ? req.url : ''
            const code = (err as NodeJS.ErrnoException).code || err.message
            console.warn(`[vite proxy] 后端暂不可达（tsx 热重启中，起来自动恢复）: ${req?.method || 'GET'} ${url.slice(0, 60)} — ${code}`)
          })
        }
      }
    }
  }
})
