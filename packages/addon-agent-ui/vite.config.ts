import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// The dev.sh script passes VITE_AGENT_PORT to point at the correct
// agent's status port (the discovery-mode agent, which is the last one).
const agentPort = process.env.VITE_AGENT_PORT ?? '4444'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
  server: {
    port: 4446,
    proxy: {
      '/api': `http://localhost:${agentPort}`,
      '/health': `http://localhost:${agentPort}`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
