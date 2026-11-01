import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // Ships self-contained (only @camstack/kernel + node builtins stay external):
  // `node-unraid` is a devDependency that bundles inline.
  externals: 'self-contained',
})
