import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 避免监听 cargo 正在写入的构建产物，导致 EBUSY 后开发服务退出
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600
  }
})
