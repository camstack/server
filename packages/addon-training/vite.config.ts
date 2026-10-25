import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'orchestrator/training.addon': 'src/orchestrator/training.addon.ts',
    'providers/modal/training-modal.addon': 'src/providers/modal/training-modal.addon.ts',
  },
  externals: 'self-contained',
})
