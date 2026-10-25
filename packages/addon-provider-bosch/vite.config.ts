import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'shc/addon': 'src/shc/addon.ts',
    'home-connect/addon': 'src/home-connect/addon.ts',
    'homecom/addon': 'src/homecom/addon.ts',
  },
  externals: 'self-contained',
})
