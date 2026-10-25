/**
 * The `ui:shots` harness: the REAL admin-ui source (`App`, pages, ui-library)
 * served by Vite with four modules swapped for stand-ins — the backend
 * (`System`) and its transport answer every tRPC call from fixture files, auth
 * is a signed-in admin, addon pages load from workspace source — so a page
 * renders with deterministic data and no hub.
 *
 * Started by `scripts/ui/shots/lib/run.ts`; `npm run ui:shots` is the entry.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { TRAINING_FRAME_SVG } from './stubs/training-frame'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PACKAGES = path.join(REPO, 'packages')
const ADMIN = path.join(PACKAGES, 'addon-admin-ui', 'src')

/** admin-ui module (resolved path) → harness stand-in. */
const STUBS: Readonly<Record<string, string>> = {
  [path.join(ADMIN, 'contexts/auth-context.tsx')]: path.join(HERE, 'stubs/auth-context.tsx'),
  [path.join(ADMIN, 'lib/backend.ts')]: path.join(HERE, 'stubs/backend.ts'),
  [path.join(ADMIN, 'layouts/AddonPageLoader.tsx')]: path.join(HERE, 'stubs/AddonPageLoader.tsx'),
  [path.join(ADMIN, 'hooks/useSocketWatchdog.ts')]: path.join(HERE, 'stubs/useSocketWatchdog.ts'),
}

interface PackageJson {
  readonly name?: string
  readonly version?: string
  readonly camstack?: {
    readonly displayName?: string
    readonly addons?: readonly ({ readonly id: string } & Record<string, unknown>)[]
  }
}

function readPackages(): { dir: string; pkg: PackageJson }[] {
  const out: { dir: string; pkg: PackageJson }[] = []
  for (const dir of fs.readdirSync(PACKAGES)) {
    const file = path.join(PACKAGES, dir, 'package.json')
    if (!fs.existsSync(file)) continue
    out.push({
      dir: path.join(PACKAGES, dir),
      pkg: JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson,
    })
  }
  return out
}

function stubs(): Plugin {
  return {
    name: 'ui-shots-stubs',
    enforce: 'pre',
    async resolveId(source, importer, opts) {
      if (!importer || importer.startsWith(path.join(HERE, 'stubs'))) return null
      if (!source.startsWith('.')) return null
      const r = await this.resolve(source, importer, { ...opts, skipSelf: true })
      return r && STUBS[r.id] ? STUBS[r.id] : null
    },
  }
}

/**
 * `virtual:ui-shots-manifests` — every workspace addon manifest (the shell
 * fixture lists them as installed); `virtual:ui-shots-addon-pages` — a lazy
 * import per `packages/addon-<x>/src/page.tsx`, keyed `<x>`.
 */
/**
 * Every addon widget bundle in the workspace: a `vite.widgets*.config.ts` names
 * its Module Federation remote (`name: '…'`) and the module it exposes
 * (`'./widgets': './src/…'`). The harness loads that SOURCE module where the
 * hub would fetch the remote, keyed `<remoteName>/<module>` like `loadRemote`.
 */
function widgetBundles(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = []
  for (const { dir } of readPackages()) {
    for (const f of fs.readdirSync(dir)) {
      if (!/^vite\.widgets.*\.config\.ts$/.test(f)) continue
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      const name = /\bname:\s*'([^']+)'/.exec(src)?.[1]
      const exposes = /exposes:\s*\{([^}]*)\}/.exec(src)?.[1] ?? ''
      if (name === undefined) continue
      for (const m of exposes.matchAll(/'\.\/([^']+)':\s*'([^']+)'/g)) {
        const file = path.join(dir, m[2] ?? '')
        if (fs.existsSync(file)) out.push({ key: `${name}/${m[1] ?? ''}`, file })
      }
    }
  }
  return out
}

function virtualModules(): Plugin {
  const MANIFESTS = 'virtual:ui-shots-manifests'
  const PAGES = 'virtual:ui-shots-addon-pages'
  const WIDGETS = 'virtual:ui-shots-addon-widgets'
  return {
    name: 'ui-shots-virtual',
    resolveId: (id) => (id === MANIFESTS || id === PAGES || id === WIDGETS ? `\0${id}` : null),
    load(id) {
      if (id === `\0${MANIFESTS}`) {
        const out = readPackages().flatMap(({ pkg }) =>
          (pkg.camstack?.addons ?? []).map((a) => ({
            ...a,
            packageName: pkg.name,
            packageVersion: pkg.version,
            packageDisplayName: pkg.camstack?.displayName,
          })),
        )
        return `export default ${JSON.stringify(out)}`
      }
      if (id === `\0${PAGES}`) {
        const entries = readPackages()
          .map(({ dir }) => ({
            key: path.basename(dir).replace(/^addon-/, ''),
            file: path.join(dir, 'src/page.tsx'),
          }))
          .filter((e) => fs.existsSync(e.file))
          .map((e) => `  ${JSON.stringify(e.key)}: () => import(${JSON.stringify(e.file)}),`)
        return `export default {\n${entries.join('\n')}\n}`
      }
      if (id === `\0${WIDGETS}`) {
        const entries = widgetBundles().map(
          (e) => `  ${JSON.stringify(e.key)}: () => import(${JSON.stringify(e.file)}),`,
        )
        return `export default {\n${entries.join('\n')}\n}`
      }
      return null
    },
  }
}

/** `/api/addon-assets/<addonId>/<file>` — addon icons from the workspace. */
function addonAssets(): Plugin {
  const byId = new Map<string, string>()
  for (const { dir, pkg } of readPackages())
    for (const a of pkg.camstack?.addons ?? []) byId.set(a.id, dir)
  return {
    name: 'ui-shots-addon-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/api\/addon-assets\/([^/]+)\/([^?]+)/.exec(req.url ?? '')
        if (!m) return next()
        const dir = byId.get(m[1] ?? '')
        const file = dir === undefined ? null : path.resolve(dir, m[2] ?? '')
        if (file === null || !file.startsWith(dir ?? '\0') || !fs.existsSync(file)) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('content-type', file.endsWith('.png') ? 'image/png' : 'image/svg+xml')
        res.end(fs.readFileSync(file))
      })
    },
  }
}

/**
 * What an addon page file does ONLY for its own standalone dev server, and the
 * host never does (D747):
 *
 * - mounts itself (`mountAddonPage` when `#root` exists), which in the harness
 *   would replace the whole admin app with the bare page;
 * - imports its own `index.css`, a second Tailwind build whose utilities come
 *   AFTER the admin build's responsive variants and silently beat them
 *   (`.hidden` over `lg:flex`) — a layout that is wrong only in the harness.
 *
 * The harness loads the page through the loader, with the admin build's CSS.
 */
function noStandaloneMount(): Plugin {
  const SELF_MOUNT = "import.meta.env?.DEV && document.getElementById('root')"
  const OWN_CSS = "import './index.css'"
  return {
    name: 'ui-shots-no-standalone-mount',
    enforce: 'pre',
    transform(code, id) {
      if (!/addon-[^/]+\/src\/page\.tsx$/.test(id.split('?')[0] ?? id)) return null
      return code.replace(SELF_MOUNT, 'false').replace(OWN_CSS, '')
    },
  }
}

/** `/addon/pipeline-analytics/retrain-frame/<id>` — the Training fixtures' synthetic frame. */
function trainingFrames(): Plugin {
  return {
    name: 'ui-shots-training-frames',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!(req.url ?? '').startsWith('/addon/pipeline-analytics/retrain-frame/')) return next()
        res.setHeader('content-type', 'image/svg+xml')
        res.end(TRAINING_FRAME_SVG)
      })
    },
  }
}

const adminVersion = (
  JSON.parse(
    fs.readFileSync(path.join(PACKAGES, 'addon-admin-ui/package.json'), 'utf8'),
  ) as PackageJson
).version

export default defineConfig({
  root: HERE,
  publicDir: path.join(PACKAGES, 'addon-admin-ui/public'),
  cacheDir: path.join(REPO, 'node_modules/.vite-ui-shots'),
  logLevel: 'warn',
  define: { __APP_VERSION__: JSON.stringify(adminVersion ?? '0.0.0') },
  plugins: [
    virtualModules(),
    noStandaloneMount(),
    stubs(),
    react(),
    tailwindcss(),
    addonAssets(),
    trainingFrames(),
  ],
  resolve: {
    alias: [
      // Widget remotes load from workspace source (`stubs/mf-runtime.ts`).
      {
        find: /^@module-federation\/runtime$/,
        replacement: path.join(HERE, 'stubs/mf-runtime.ts'),
      },
      { find: /^@camstack\/sdk$/, replacement: path.join(PACKAGES, 'sdk/src/index.ts') },
      {
        find: /^@camstack\/ui-library$/,
        replacement: path.join(PACKAGES, 'ui-library/src/index.ts'),
      },
      {
        find: /^@camstack\/ui-library\/(.*)$/,
        replacement: path.join(PACKAGES, 'ui-library/src/$1'),
      },
      {
        find: /^@camstack\/types\/client$/,
        replacement: path.join(PACKAGES, 'types/src/client.ts'),
      },
      { find: /^@camstack\/types\/enums$/, replacement: path.join(PACKAGES, 'types/src/enums.ts') },
      { find: /^@camstack\/types$/, replacement: path.join(PACKAGES, 'types/src/index.ts') },
      // A types module hashes at load time; the browser has no node:crypto.
      { find: /^node:crypto$/, replacement: path.join(HERE, 'stubs/node-crypto.ts') },
      { find: /^@admin\/(.*)$/, replacement: `${ADMIN}/$1` },
    ],
    dedupe: [
      '@trpc/client',
      '@trpc/react-query',
      '@trpc/server',
      'react',
      'react-dom',
      '@tanstack/react-query',
      'react-router-dom',
      'react-i18next',
      'i18next',
    ],
  },
  // Local-only (binds localhost). Not strict: in a git worktree node_modules
  // resolves outside the repository root.
  server: { strictPort: true, host: '127.0.0.1', fs: { strict: false } },
})
