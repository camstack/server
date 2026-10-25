import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
    'ha-export/ha-export.addon': 'src/ha-export/ha-export.addon.ts',
  },
  externals: 'self-contained',
})
