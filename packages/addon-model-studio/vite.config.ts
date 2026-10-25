import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'model-studio.addon': 'src/model-studio.addon.ts',
  },
  externals: 'self-contained',
})
