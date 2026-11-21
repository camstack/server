import { fileURLToPath } from 'node:url'
import { pureInitializers } from '../../tools/build/pure-initializers.ts'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Framework package — types. DTS still emitted by tsc separately
 * (build script chains `vite build && tsc -p tsconfig.json
 * --emitDeclarationOnly`) because tsup historically truncated the
 * massive AppRouter type. Same workaround applies under Vite —
 * vite-plugin-dts has the same TS compiler limits as tsup's DTS.
 */
const preset = buildLibPreset({
  entries: {
    index: 'src/index.ts',
    node: 'src/node.ts',
    // Lightweight addon-authoring/runner entry — avoids the full schema barrel
    // (~47MB heap per process). See src/addon.ts.
    addon: 'src/addon.ts',
    // Dependency-free enums (EventCategory, EventSourceType) — a runtime entry
    // small enough for CLIENT bundles (the RN/Expo viewer imports the bus
    // categories from here without dragging the schema barrel into Metro).
    enums: 'src/enums/index.ts',
    // Node palette ids + assignNodeColorId — small entry for store schemas and UI.
    'node-color': 'src/node-color.ts',
    // Table + conversion only (no zod) — the device-template render worker's unit filter.
    'units-lean': 'src/units-lean.ts',
    // Filter/global/variable catalogue — the render worker reads argument caps
    // from here without loading the types barrel (D453).
    'device-template-catalogue': 'src/device-template-catalogue.ts',
    // Test doubles for addon authors (fakeAddonContext) — bundles the tRPC
    // client, so it stays off the root entry.
    testing: 'src/testing.ts',
  },
  externals: 'framework',
})

/**
 * Tree-shakable for the addon bundles that inline this package (D15, D1074):
 *
 *  - `dist/esm/` keeps one ESM file per source module (`preserveModules`) and the `module`
 *    export condition points there, so a consumer BUNDLER (the addon builds, vite) can drop
 *    every module and every initializer the addon does not reach (`"sideEffects": false` in
 *    package.json, `/* @__PURE__ *\/` on initializer calls through the plugin below);
 *  - `dist/*.mjs` and `dist/*.js` stay one bundled file per entry: Node (`import`, `require`)
 *    and vitest load those. They are NOT replaced by `dist/esm/`: vitest crawls a package's
 *    ESM module graph and ran out of memory on ~700 small files (`vitest related`).
 */
export default {
  ...preset,
  plugins: [
    ...(preset.plugins ?? []),
    pureInitializers(fileURLToPath(new URL('./src/', import.meta.url))),
  ],
  build: {
    ...preset.build,
    rollupOptions: {
      ...preset.build?.rollupOptions,
      output: [
        {
          format: 'cjs',
          entryFileNames: '[name].js',
          preserveModules: false,
          manualChunks: () => null,
        },
        {
          format: 'es',
          entryFileNames: '[name].mjs',
          preserveModules: false,
          manualChunks: () => null,
        },
        {
          format: 'es',
          entryFileNames: 'esm/[name].mjs',
          preserveModules: true,
          preserveModulesRoot: 'src',
        },
      ],
    },
  },
}
