import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'provider-zigbee-z2m.addon': 'src/provider-zigbee-z2m.addon.ts',
  },
  externals: 'self-contained',
})
