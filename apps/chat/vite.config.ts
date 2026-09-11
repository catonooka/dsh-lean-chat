import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs: the dist is served from the site root by the chat
  // bundle, and relative URLs survive any mount point.
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    // The dist is served as-is in production; shipping .map files there
    // only hands out the source tree and pads the folder.
    sourcemap: false,
  },
  server: {
    port: 5175,
    proxy: {
      // Dev loop: `pnpm --filter @deepseek-ai/dsh-chat-frontend run dev` against
      // a running `pnpm dsh --profile chat --no-open`.
      '/api': 'http://127.0.0.1:3095',
    },
  },
})
