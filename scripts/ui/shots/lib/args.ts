/**
 * `npm run ui:shots` arguments.
 *
 *   --route <path>        admin-ui route to shoot (repeatable; must start with `/`)
 *   --fixtures <a,b>      fixture areas to load (default: every area); `shell` is always loaded
 *   --label <name>        run name, e.g. before | after (default: current)
 *   --out <dir>           output directory (default: scratchpad/ui-shots/<label>)
 *   --compare <dir>       an earlier run's directory: side-by-side paths + regression flags
 *   --theme light|dark    only this theme (default: both)
 *   --viewport WxH        only these viewports (repeatable; default 1440x900 + 390x844)
 *   --port <n>            harness dev-server port (default 3967)
 *   --wait <ms>           settle time after load (default 2500)
 *   --step <action>       an interaction before the shot (repeatable, in order):
 *                           click:<selector> | wait:<ms> | key:<Key> |
 *                           mouse:<selector>:<fx>:<fy>  (move to a fraction of the element's box) |
 *                           js:<expression>  (run in the page, print its JSON — layout assertions)
 */
import * as path from 'node:path'

export type Theme = 'light' | 'dark'

export interface Viewport {
  readonly name: string
  readonly width: number
  readonly height: number
}

export interface ShotsArgs {
  readonly routes: readonly string[]
  readonly fixtures: readonly string[] | 'all'
  readonly label: string
  readonly out: string
  readonly compare: string | null
  readonly themes: readonly Theme[]
  readonly viewports: readonly Viewport[]
  readonly port: number
  readonly wait: number
  readonly steps: readonly string[]
}

export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]
export const DEFAULT_OUT_ROOT = 'scratchpad/ui-shots'
const DEFAULT_PORT = 3967
const DEFAULT_WAIT_MS = 2500
const VALUE_FLAGS = new Set([
  'route',
  'fixtures',
  'label',
  'out',
  'compare',
  'theme',
  'viewport',
  'port',
  'wait',
  'step',
])

export const USAGE =
  'usage: npm run ui:shots -- --route "/system/identity?tab=access" [--fixtures access] [--label before|after] [--out <dir>] [--compare <before-dir>] [--theme light|dark] [--viewport 1440x900]'

/** `--flag value` / `--flag=value` pairs, in order. */
function pairs(argv: readonly string[]): { flag: string; value: string }[] | string {
  const out: { flag: string; value: string }[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('--')) return `unexpected argument "${arg}"`
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!VALUE_FLAGS.has(flag)) return `unknown flag --${flag}`
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || value === '') return `--${flag} needs a value`
    out.push({ flag, value })
  }
  return out
}

function parseViewport(v: string): Viewport | null {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(v)
  if (!m) return null
  return { name: v, width: Number(m[1]), height: Number(m[2]) }
}

export function parseShotsArgs(
  argv: readonly string[],
  root: string,
): ShotsArgs | { error: string } {
  const parsed = pairs(argv)
  if (typeof parsed === 'string') return { error: parsed }
  const all = (flag: string): string[] => parsed.filter((p) => p.flag === flag).map((p) => p.value)
  const last = (flag: string): string | undefined => all(flag).at(-1)

  const routes = all('route')
  if (routes.length === 0) return { error: 'at least one --route is required' }
  const badRoute = routes.find((r) => !r.startsWith('/'))
  if (badRoute !== undefined) return { error: `--route must start with "/": ${badRoute}` }

  const label = last('label') ?? 'current'
  if (!/^[\w.-]+$/.test(label) || label.startsWith('.')) {
    return { error: `--label must be a plain name (letters, digits, . _ -): ${label}` }
  }

  const themes: Theme[] = []
  for (const t of all('theme')) {
    if (t !== 'light' && t !== 'dark') return { error: `--theme must be light or dark: ${t}` }
    if (!themes.includes(t)) themes.push(t)
  }

  const viewports: Viewport[] = []
  for (const v of all('viewport')) {
    const vp = parseViewport(v)
    if (vp === null) return { error: `--viewport must be WIDTHxHEIGHT, e.g. 320x640: ${v}` }
    viewports.push(vp)
  }

  const fixturesArg = last('fixtures')
  const fixtures =
    fixturesArg === undefined || fixturesArg === 'all'
      ? 'all'
      : fixturesArg
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)

  const outArg = last('out')
  const compareArg = last('compare')
  const port = Number(last('port') ?? DEFAULT_PORT)
  const wait = Number(last('wait') ?? DEFAULT_WAIT_MS)
  if (!Number.isInteger(port) || port <= 0) return { error: '--port must be a positive integer' }
  if (!Number.isFinite(wait) || wait < 0) return { error: '--wait must be a number of ms' }

  return {
    routes,
    fixtures,
    label,
    out: path.resolve(root, outArg ?? path.join(DEFAULT_OUT_ROOT, label)),
    compare: compareArg === undefined ? null : path.resolve(root, compareArg),
    themes: themes.length > 0 ? themes : ['light', 'dark'],
    viewports: viewports.length > 0 ? viewports : DEFAULT_VIEWPORTS,
    port,
    wait,
    steps: all('step'),
  }
}
