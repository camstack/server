import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // `@apocaliss92/nodedreo` is a pure-TS dependency (its only runtime dep is
  // `ws`); it bundles inline so the addon ships self-contained (only
  // @camstack/kernel + node builtins stay external). See
  // tools/build/vite-lib.preset.ts.
  externals: 'self-contained',
})
