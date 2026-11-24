#!/usr/bin/env node
/**
 * gen-closure-pins — derive `server/backend/closure-pins.json` from the root
 * `package-lock.json` (#681).
 *
 * Without it every `npm install @camstack/server@X` (applyServerUpdate on the
 * hub and the agents, the Docker image, the desktop install) resolves each
 * third-party range against the live registry, so a package published after
 * the release was tested can enter the closure. The file maps every
 * third-party package of the production closure to the exact version the
 * lockfile tested; the installer writes it as `overrides` into the staging
 * package.json (npm honours `overrides` only in the ROOT project, so a
 * shrinkwrap shipped inside the server cannot do this: it nests the whole tree
 * under the server and omits the addons).
 *
 *   node scripts/gen-closure-pins.mjs            # write server/backend/closure-pins.json
 *   node scripts/gen-closure-pins.mjs --check    # exit 1 when the file on disk disagrees
 *
 * Runs from `server/backend`'s `prepack`, so `npm pack`, `npm publish` and
 * `camstack deploy --closure` all carry it; the file is git-ignored, so a
 * checked-out commit can never carry pins that disagree with the lockfile.
 * No `@camstack/*` entry: those resolve from their published versions.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_DIR = 'server/backend'
export const PINS_FILE = 'closure-pins.json'

/** Names of the dependency maps that npm installs for a consumer. */
const EDGE_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/**
 * The lockfile key a `name` required from `fromKey` resolves to: the nearest
 * `node_modules/<name>` walking up, ending at the root `node_modules`.
 */
function resolveKey(packages, fromKey, name) {
  let base = fromKey
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`
    if (packages[candidate] !== undefined) return candidate
    if (base === '') return null
    const idx = base.lastIndexOf('/node_modules/')
    base = idx !== -1 ? base.slice(0, idx) : ''
  }
}

function edgesOf(entry) {
  const meta = entry.peerDependenciesMeta ?? {}
  const out = []
  for (const field of EDGE_FIELDS) {
    for (const name of Object.keys(entry[field] ?? {})) {
      if (field === 'peerDependencies' && meta[name]?.optional === true) continue
      out.push(name)
    }
  }
  return out
}

/**
 * The production closure of the server: every third-party lockfile entry
 * reachable from it, walking THROUGH the workspace packages (addons, sdk,
 * types, ui-library) but never listing them.
 *
 * @param {{ packages: Record<string, any> }} lock parsed package-lock.json (v3)
 * @returns {Map<string, any>} lockfile key -> entry
 */
function walkClosure(lock, serverDir) {
  const packages = lock.packages
  if (packages[serverDir] === undefined) throw new Error(`lockfile has no "${serverDir}" entry`)
  const reached = new Map()
  const visited = new Set()
  const queue = [serverDir]
  while (queue.length > 0) {
    const fromKey = queue.pop()
    if (visited.has(fromKey)) continue
    visited.add(fromKey)
    const entry = packages[fromKey]
    if (entry === undefined) continue
    for (const name of edgesOf(entry)) {
      const key = resolveKey(packages, fromKey, name)
      if (key === null) continue // not in the lockfile: npm resolves it normally
      const target = packages[key]
      if (target.link === true) {
        queue.push(target.resolved)
        continue
      }
      if (reached.has(key)) continue
      reached.set(key, target)
      queue.push(key)
    }
  }
  return reached
}

/** `node_modules/@a/b/node_modules/c` -> `c`; `node_modules/@a/b` -> `@a/b`. */
function packageNameOf(key) {
  const idx = key.lastIndexOf('node_modules/')
  return key.slice(idx + 'node_modules/'.length)
}

/**
 * `{ name: exactVersion }` for every third-party package in the production
 * closure. A name that resolves to MORE THAN ONE version in the closure is left
 * out: an npm `override` is by name and would force one version on every
 * dependent, including ones whose range the lockfile satisfied with another.
 * Left out means "resolved as today", never a failure.
 *
 * @param {{ packages: Record<string, any> }} lock
 * @param {{ serverDir?: string }} [opts]
 * @returns {{ pins: Record<string, string>, stats: { pinned: number, ambiguous: string[] } }}
 */
export function buildPins(lock, opts = {}) {
  const reached = walkClosure(lock, opts.serverDir ?? SERVER_DIR)
  const versions = new Map()
  for (const [key, entry] of reached) {
    if (typeof entry.version !== 'string') continue
    const name = packageNameOf(key)
    if (name.startsWith('@camstack/')) continue
    const set = versions.get(name) ?? new Set()
    set.add(entry.version)
    versions.set(name, set)
  }
  const pins = {}
  const ambiguous = []
  for (const name of [...versions.keys()].sort()) {
    const set = versions.get(name)
    if (set.size === 1) pins[name] = [...set][0]
    else ambiguous.push(name)
  }
  return { pins, stats: { pinned: Object.keys(pins).length, ambiguous } }
}

/**
 * Write (or `--check`) `<repo>/server/backend/closure-pins.json`.
 *
 * A missing or unusable root lockfile (a checkout without it, a lockfile with
 * no server entry) must not break `npm pack` / `npm publish`: nothing is
 * written, a warning says the closure ships unpinned, and `ok` stays true —
 * which is what the closure did before pins existed. Only `--check` fails.
 *
 * @returns {{ ok: boolean, written: boolean, message: string }}
 */
export function generateClosurePins(repo, opts = {}) {
  const target = path.join(repo, SERVER_DIR, PINS_FILE)
  let result
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'))
    result = buildPins(lock)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: opts.check !== true,
      written: false,
      message: `[closure-pins] WARNING: no pins written, the closure ships unpinned (${reason})`,
    }
  }
  const { pins, stats } = result
  const text = `${JSON.stringify(pins, null, 2)}\n`
  if (opts.check === true) {
    const onDisk = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
    return onDisk === text
      ? { ok: true, written: false, message: '' }
      : { ok: false, written: false, message: `${target} disagrees with package-lock.json` }
  }
  fs.writeFileSync(target, text)
  return {
    ok: true,
    written: true,
    message: `[closure-pins] ${stats.pinned} pins (${stats.ambiguous.length} ambiguous left out) -> ${target}`,
  }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const result = generateClosurePins(path.resolve(here, '..'), {
    check: process.argv.includes('--check'),
  })
  if (result.message !== '') process.stderr.write(`${result.message}\n`)
  if (!result.ok) process.exit(1)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
