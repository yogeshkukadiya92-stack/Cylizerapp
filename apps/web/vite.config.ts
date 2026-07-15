import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  envDir: '../..',
  plugins: [react()],
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
  },
})
