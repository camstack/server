import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'google-services.addon': 'src/google-services.addon.ts',
  },
  externals: 'self-contained',
})
