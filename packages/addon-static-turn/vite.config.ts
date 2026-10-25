import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'static-turn.addon': 'src/static-turn.addon.ts',
  },
  externals: 'self-contained',
})
