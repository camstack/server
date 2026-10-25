import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'export-alexa.addon': 'src/export-alexa.addon.ts',
  },
  externals: 'self-contained',
})
