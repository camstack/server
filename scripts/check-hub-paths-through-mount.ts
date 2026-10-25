#!/usr/bin/env tsx
/**
 * Hub-path guard — every URL the web UI composes toward the hub goes through
 * the mount resolver.
 *
 * ## The failure this catches
 *
 * The admin UI can be served under a PATH PREFIX decided at runtime by a
 * reverse proxy: the Home Assistant component frames it through a
 * same-origin relay, `https://<ha>/api/camstack/p/<grant>/…` → hub `/…`, so
 * the browser never has to trust the hub's local certificate. The hub injects
 * `<base href>` + `<meta name="camstack-mount">` into the shell, and
 * `packages/ui-library/src/lib/hub-mount.ts` turns that into `hubPath()` /
 * `hubUrl()` / `hubOrigin()`.
 *
 * A literal `'/api/…'` or `` `/addon/…` `` bypasses all of that: `<base>` does
 * not apply to a root-absolute path, so the request leaves the relay and
 * lands on the HA origin's own `/api/…` — a 404 (or, for `/api/…` on HA, a
 * DIFFERENT application). Before this guard there were ~31 of them across
 * ~22 files plus six `window.location.origin` bases. Each one is invisible in
 * review because at the root mount the two spellings behave identically.
 *
 * ## What it checks (`packages/addon-admin-ui/src`, `packages/ui-library/src`)
 *
 * 1. `bare-hub-path` — a string literal starting with one of the hub's
 *    top-level route prefixes (`/api`, `/trpc`, `/addon`, `/assets`, `/auth`,
 *    `/ws`, `/viewer`, `/health`, `/adaptive-probe`) or one of the files the
 *    SHELL serves from its own root (`/brand`, `/icons`, `/favicon.svg`,
 *    `/manifest.webmanifest`, `/sw.js`), that is NOT the direct argument of
 *    `hubPath(` / `hubUrl(` / `hubWsUrl(`. The static ones are not an
 *    afterthought: with the route prefixes already covered, a prefixed
 *    browser run still leaked six `/brand/logo-horizontal-dark.svg` requests
 *    onto the HA origin, and they 404'd.
 * 2. `page-origin` — `window.location.origin` / `location.origin` used as a
 *    server base. The page origin is the RELAY's origin; the hub base is
 *    `hubOrigin()`.
 *
 * A line that legitimately carries such a literal — a react-router route
 * pattern, a path composed on a `serverUrl` PROP the caller already resolved
 * — says so with `// hub-path-ok: <reason>` on the same line. The reason is
 * mandatory: a bare marker is a violation.
 *
 * Comments, tests and the resolver module itself are skipped.
 *
 * Usage: tsx scripts/check-hub-paths-through-mount.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The two web surfaces the hub serves and that talk back to it. */
const SCANNED_DIRS: readonly string[] = ['packages/addon-admin-ui/src', 'packages/ui-library/src']

/** The one module allowed to know the page origin and the raw hub paths. */
const RESOLVER_MODULE = 'packages/ui-library/src/lib/hub-mount.ts'

export interface HubPathSourceFile {
  readonly path: string
  readonly source: string
}

export interface HubPathViolation {
  readonly path: string
  readonly line: number
  readonly rule: 'bare-hub-path' | 'page-origin'
  readonly text: string
}

const HUB_ROUTE_PREFIXES = [
  'api',
  'trpc',
  'addon',
  'assets',
  'auth',
  'ws',
  'viewer',
  'health',
  'adaptive-probe',
  // Static files the SHELL serves from its own root. They look inert, and
  // they are exactly what leaked: six `/brand/logo-horizontal-dark.svg`
  // requests left the relay and 404'd on the HA origin while every other URL
  // on the page was correct. A relative `brand/…` is not the fix either — at
  // the root mount it would resolve against `/devices/5/`.
  'brand',
  'icons',
  'favicon.svg',
  'manifest.webmanifest',
  'sw.js',
] as const

/** A quote, then a root-absolute path into one of the hub's route trees. */
const BARE_HUB_PATH_RE = new RegExp(
  `(?<![\\w$])(hubPath\\(|hubUrl\\(|hubWsUrl\\(|hubPathFor\\()?\\s*(['"\`])/(${HUB_ROUTE_PREFIXES.map((p) => p.replace(/\./g, '\\.')).join('|')})(?=[/'"\`?]|$)`,
  'g',
)

const PAGE_ORIGIN_RE = /\b(?:window\.)?location\.origin\b/

/** A line that ends by opening one of the resolvers. */
const OPENS_RESOLVER_RE = /\b(?:hubPath|hubUrl|hubWsUrl)\(\s*$/

function previousNonBlank(lines: readonly string[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = lines[i]
    if (candidate !== undefined && candidate.trim() !== '') return candidate
  }
  return ''
}

/** `// hub-path-ok: <reason>` — the reason is required. */
const MARKER_RE = /hub-path-ok:\s*\S/

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/(?!.*hub-path-ok:)[^\n]*/g, (_m, lead: string) => lead)
}

function isScanned(filePath: string): boolean {
  if (!SCANNED_DIRS.some((dir) => filePath.startsWith(`${dir}/`))) return false
  if (filePath === RESOLVER_MODULE) return false
  if (filePath.includes('/__tests__/')) return false
  if (/\.(spec|test)\.tsx?$/.test(filePath)) return false
  return true
}

export function findHubPathViolations(
  files: readonly HubPathSourceFile[],
): readonly HubPathViolation[] {
  const violations: HubPathViolation[] = []
  for (const file of files) {
    if (!isScanned(file.path)) continue
    const lines = stripComments(file.source).split('\n')
    lines.forEach((text, index) => {
      if (MARKER_RE.test(text)) return
      const line = index + 1
      const trimmed = text.trim().slice(0, 160)
      // The formatter wraps a long call as `hubPath(\n  '/api/…',\n)`: the
      // literal is still the resolver's first argument when the previous
      // non-blank line ends by opening it.
      const openedAbove = OPENS_RESOLVER_RE.test(previousNonBlank(lines, index))
      BARE_HUB_PATH_RE.lastIndex = 0
      const code = text.trimStart()
      let match: RegExpExecArray | null = BARE_HUB_PATH_RE.exec(code)
      while (match !== null) {
        const wrapped = match[1] !== undefined || (openedAbove && match.index === 0)
        if (!wrapped) {
          violations.push({ path: file.path, line, rule: 'bare-hub-path', text: trimmed })
          break
        }
        match = BARE_HUB_PATH_RE.exec(code)
      }
      if (PAGE_ORIGIN_RE.test(text)) {
        violations.push({ path: file.path, line, rule: 'page-origin', text: trimmed })
      }
    })
  }
  return violations
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walk(p, out)
      continue
    }
    if (/\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

function main(): void {
  const files: HubPathSourceFile[] = []
  for (const dir of SCANNED_DIRS) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/')
      files.push({ path: rel, source: fs.readFileSync(abs, 'utf8') })
    }
  }
  if (files.length === 0) {
    console.error('✗ hub-path guard: scanned no files — the scan roots have moved')
    process.exit(1)
  }
  if (!fs.existsSync(path.join(ROOT, RESOLVER_MODULE))) {
    console.error(`✗ hub-path guard: the resolver module ${RESOLVER_MODULE} is gone`)
    process.exit(1)
  }

  const violations = findHubPathViolations(files)
  if (violations.length === 0) {
    console.log(
      `✓ hub-path guard: ${files.length} files, every hub URL is composed through hub-mount.ts`,
    )
    return
  }

  console.error('✗ hub-path guard: a hub URL that bypasses the mount resolver\n')
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  [${v.rule}]\n      ${v.text}`)
  }
  console.error(
    '\n  A root-absolute path ignores <base>, so under the Home Assistant relay it\n' +
      "  leaves the relay. Wrap the literal: hubPath('/api/…') for a same-origin\n" +
      '  request, hubUrl()/hubWsUrl() for an absolute one, hubOrigin() instead of\n' +
      '  window.location.origin as a server base. A line that must keep the literal\n' +
      '  (a router pattern, a path composed on a resolved serverUrl prop) says why:\n' +
      '  // hub-path-ok: <reason>',
  )
  process.exit(1)
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
