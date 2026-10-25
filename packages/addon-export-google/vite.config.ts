import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'export-google.addon': 'src/export-google.addon.ts',
  },
  externals: 'self-contained',
})
