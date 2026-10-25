import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // Ships self-contained (only @camstack/kernel + node builtins stay
  // external). Once a UniFi controller-API client lib is wired it bundles inline
  // here too.
  externals: 'self-contained',
})
