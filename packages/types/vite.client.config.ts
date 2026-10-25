import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * `@camstack/types/client` — built ALONE, after the main build (D721).
 *
 * Alone because of one knob: `moduleSideEffects: false`. Rolldown otherwise
 * keeps every module the barrel imports in case its top level has an effect,
 * and a `z.object(...)` at module scope looks exactly like one — so the client
 * entry came out as large as the barrel it was meant to replace. The main
 * entries keep the default: the hub and the addons import them whole and
 * nothing there is worth the risk of dropping a registration.
 *
 * `emptyOutDir: false` — the main build already wrote `dist/`.
 */
const preset = buildLibPreset({
  entries: { client: 'src/client.ts' },
  externals: 'framework',
})

export default {
  ...preset,
  build: {
    ...preset.build,
    emptyOutDir: false,
    rollupOptions: {
      ...preset.build?.rollupOptions,
      treeshake: { moduleSideEffects: false },
    },
  },
}
