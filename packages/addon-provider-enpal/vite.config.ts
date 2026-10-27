import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // Pure TypeScript over `fetch`: no runtime dependency, ships self-contained
  // (only @camstack/kernel + node builtins stay external).
  externals: 'self-contained',
})
