import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Framework package — sdk. DTS still emitted via separate tsc step
 * (build script: `vite build && tsc -p tsconfig.build.json`) — same
 * pattern as types.
 */
export default buildLibPreset({
  entries: { index: 'src/index.ts' },
  externals: 'framework',
})
