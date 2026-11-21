import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: { index: 'src/index.ts', addon: 'src/addon.ts' },
  // The Dreo library runs in the bundled Python worker (python/), not in this bundle; only
  // the TypeScript side ships here, self-contained (see tools/build/vite-lib.preset.ts).
  externals: 'self-contained',
})
