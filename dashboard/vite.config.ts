import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // Shared dashboard contract: import type { Snapshot } from "@contract/types"
      { find: '@contract', replacement: fileURLToPath(new URL('../contract', import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
})
