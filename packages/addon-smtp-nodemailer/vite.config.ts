import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'smtp.addon': 'src/smtp.addon.ts',
  },
  externals: 'self-contained',
})
