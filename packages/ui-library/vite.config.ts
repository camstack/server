import { defineConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Framework package — ui-library. Consumed by admin-ui + agent-ui +
 * Storybook. Declarations are emitted by `scripts/tsc7 -p tsconfig.dts.json`
 * after `vite build` (P2) — not by vite-plugin-dts.
 */
const base = buildLibPreset({
  entries: {
    index: 'src/index.ts',
    'theme/index': 'src/theme/index.ts',
    'theme/tokens': 'src/theme/tokens.ts',
  },
  externals: 'framework+ui',
})

export default defineConfig(base)
