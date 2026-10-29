import type { Plugin } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * `klf-200-api` imports `disposablestack/auto`, a polyfill for the explicit
 * resource management globals (`DisposableStack`, `Symbol.dispose`). CamStack
 * requires Node 24+, which ships them natively, so the polyfill (and the
 * ~2.5 MB of `es-abstract` it drags in) stays out of the addon bundle.
 */
const nativeDisposables: Plugin = {
  name: 'velux-native-disposables',
  enforce: 'pre',
  resolveId: (id) => (id === 'disposablestack/auto' ? '\0velux-empty-polyfill' : null),
  load: (id) => (id === '\0velux-empty-polyfill' ? 'export {}' : null),
}

const base = buildLibPreset({
  entries: {
    index: 'src/index.ts',
    addon: 'src/addon.ts',
  },
  // Ships self-contained (only @camstack/kernel + node builtins stay
  // external): the klf-200-api library (a devDependency) is bundled inline.
  externals: 'self-contained',
})

export default {
  ...base,
  plugins: [nativeDisposables, ...(base.plugins ?? [])],
}
