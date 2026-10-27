import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // `esphome-client` is a zero-dependency pure-TS library, so it bundles inline
  // and the addon ships self-contained (only @camstack/kernel + node builtins
  // stay external). See tools/build/vite-lib.preset.ts.
  externals: 'self-contained',
})
