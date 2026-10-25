import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'waste-collections.addon': 'src/waste-collections.addon.ts',
  },
  externals: 'self-contained',
})
