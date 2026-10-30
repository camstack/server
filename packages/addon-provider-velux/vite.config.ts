import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * `klf-200-api` decodes every frame the gateway sends by loading ONE module per
 * command at run time: `import(file://<its own dir>/<GW_COMMAND>.js)` in
 * `FrameRcvFactory`. Bundled, "its own dir" is the addon's `dist/`, which holds
 * none of those files, so the very first reply (`GW_PASSWORD_ENTER_CFM`) failed
 * with `Cannot find module .../dist/GW_PASSWORD_ENTER_CFM.js`. This rewrites the
 * factory into a static registry over the same modules, so the bundle needs no
 * file beside it and nothing else has to be packed.
 */
const FRAME_FACTORY_PATH = /klf-200-api\/dist\/KLF200-API\/FrameRcvFactory\.js$/

const staticFrameModules: Plugin = {
  name: 'velux-static-frame-modules',
  enforce: 'pre',
  transform(_code, id) {
    const path = id.split('?', 1)[0] ?? id
    if (!FRAME_FACTORY_PATH.test(path)) return null
    const modules = readdirSync(dirname(path))
      .filter((file) => /^GW_.+\.js$/.test(file))
      .map((file) => file.slice(0, -'.js'.length))
      .sort()
    const imports = modules.map((name) => `import * as ${name} from './${name}.js'`).join('\n')
    return `import { GatewayCommand } from './common.js'
${imports}
const registry = { ${modules.join(', ')} }
export class FrameRcvFactory {
  static async CreateRcvFrame(Buff) {
    const CommandName = GatewayCommand[Buff.readUInt16BE(1)]
    await this.LoadModule(CommandName)
    const typeToCreate = this.modules[CommandName][CommandName]
    if (typeToCreate === undefined) throw new Error('Unknown command ' + CommandName + '.')
    return new typeToCreate(Buff)
  }
  static modules = {}
  static async LoadModule(moduleName) {
    if (this.modules[moduleName]) return
    const loaded = registry[moduleName]
    if (loaded === undefined) throw new Error('Unknown command ' + moduleName + '.')
    this.modules[moduleName] = loaded
  }
}
`
  },
}

/**
 * The library's login and socket handlers write `console.error` / `console.warn`.
 * Left alone they reach the runner's raw output with no integration tag; this
 * points them at `src/klf-library-log.ts`, which forwards to the addon logger.
 */
const LIBRARY_LOG_SINK = fileURLToPath(new URL('./src/klf-library-log.ts', import.meta.url))
const LIBRARY_CONNECTION_PATH = /klf-200-api\/dist\/connection\.js$/

const libraryDiagnostics: Plugin = {
  name: 'velux-library-diagnostics',
  enforce: 'pre',
  transform(code, id) {
    const path = id.split('?', 1)[0] ?? id
    if (!LIBRARY_CONNECTION_PATH.test(path)) return null
    const routed = code.replace(/\bconsole\.(error|warn)\(/g, 'klfLibraryLog.$1(')
    if (routed === code) return null
    return `import { klfLibraryLog } from ${JSON.stringify(LIBRARY_LOG_SINK)}\n${routed}`
  },
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
  plugins: [nativeDisposables, staticFrameModules, libraryDiagnostics, ...(base.plugins ?? [])],
}
