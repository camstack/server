import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'mqtt-broker.addon': 'src/mqtt-broker.addon.ts',
  },
  externals: 'self-contained',
})
