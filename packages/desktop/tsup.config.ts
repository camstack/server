import { resolve } from 'node:path'
import { defineConfig } from 'tsup'

/**
 * Electron main-process build.
 *
 * We BUNDLE (not plain `tsc`) so the PRIVATE `@camstack/node-root` workspace
 * package is inlined into `dist/main.js`. `node-root` is a devDependency —
 * electron-builder prunes devDependencies out of the packaged asar, so a
 * runtime `require('@camstack/node-root')` (which tsc would emit, since it does
 * NOT inline cross-module constants) would throw MODULE_NOT_FOUND in the
 * packaged app. Bundling with `noExternal` folds node-root's layout constants
 * (SERVER_ROOT_DIRNAME, SERVER_ROOT_STATE_FILE, RESTART_INTENT_FILE) straight
 * into the emitted JS — one source of truth, zero runtime dependency. This
 * mirrors the server-root barrel bundling in `server/backend/tsup.config.ts`.
 *
 * Three standalone CJS entry points map 1:1 onto the electron-builder config:
 *   - main.js       → package.json "main"
 *   - preload.js    → setup-window webPreferences.preload
 *   - preload-ui.js → main-window webPreferences.preload
 * Preloads MUST stay independent CJS files (Electron loads them by path), which
 * a per-entry CJS bundle guarantees (esbuild does not code-split CJS output).
 *
 * Real (production) dependencies stay external so they load from the asar's
 * node_modules: `electron` (runtime-provided), `electron-updater`,
 * `electron-store`. Node built-ins are auto-externalised by `platform: 'node'`.
 * Target matches the Node version bundled in Electron 42 (Node 22).
 */
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    preload: 'src/preload.ts',
    'preload-ui': 'src/preload-ui.ts',
    // The Windows service's supervisor: a standalone file run by the BUNDLED
    // Node (outside the asar), see src/windows-service/supervisor.ts.
    'service-supervisor': 'src/windows-service/service-supervisor-main.ts',
  },
  // Resolve @camstack/node-root from SOURCE via tsconfig paths (esbuild honors
  // them) — the desktop build is self-sufficient: node-root needs no prior
  // build (its dist/dts step was flaky on the CI mac runners).
  tsconfig: 'tsconfig.main.json',
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  external: ['electron', 'electron-updater', 'electron-store'],
  noExternal: [/^@camstack\/node-root/, /^@camstack\/owner-only-file/],
  // ONE file of `@camstack/types` is shared with the shell (the owner-only
  // file helper; zero imports beyond node builtins). Importing it through the
  // `@camstack/types/node` entry would drag ~560 KB of unrelated code into
  // main.js, so it is aliased straight to its source.
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@camstack/owner-only-file': resolve(__dirname, '../types/src/util/owner-only-file.ts'),
    }
  },
  dts: false,
  sourcemap: false,
  clean: true,
})
