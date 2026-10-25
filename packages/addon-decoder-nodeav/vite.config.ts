import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
  },
  externals: 'self-contained',
})
