import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // `@apocaliss92/nodetuya` is a pure-TS/JS dependency (zero runtime deps) — it
  // bundles inline so the addon ships self-contained. See tools/build/vite-lib.preset.ts.
  externals: 'self-contained',
})
