import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Keep these out of the bundle so npm resolves them at install time:
  //   • @camstack/server — optional dep, dynamic-imported only for serve/agent
  //   • @clack/prompts   — runtime dep, ESM-only with peer-style deps we
  //     don't want to inline (sisteransi, picocolors, etc.)
  //   • @camstack/develop — ships skills/ + templates/ beside dist/; bundling
  //     would break import.meta.url resolution for those directories.
  external: ['@camstack/server/main.js', '@clack/prompts', '@camstack/develop'],
})
