#!/usr/bin/env node
/**
 * stamp-requires — writes the minimum versions a release needs (D988) into the
 * package.json files being published, right after "Bump package versions".
 *
 *   node scripts/ci/stamp-requires.mjs <comma-separated package dirs>
 *
 *  - every ADDON package in the set   requires.server = ">=<server version>"
 *    (the server this build was cut against — it cannot be older than that).
 *  - the SERVER (server/backend), when in the set:
 *      requires.addons  = every addon package published in the same batch,
 *                         at its new version — a server release and the addons
 *                         that changed with it move together;
 *      requires.wrapper = the hand-kept `scripts/ci/wrapper-minimums.json`.
 *  - a WRAPPER (desktop, node-root) keeps its own hand-written
 *    `requires.server`; it is not touched here.
 *
 * Nothing else in the package.json changes, and a package already carrying the
 * stamp is left byte-identical (idempotent).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_DIR = 'server/backend'

const WRAPPER_MINIMUMS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'wrapper-minimums.json',
)

/** A package is an addon when it declares addon entries. */
function isAddon(pkg) {
  return typeof pkg.camstack === 'object' && pkg.camstack !== null && 'addons' in pkg.camstack
}

/**
 * Pure: the `requires` block each published package should carry.
 * `packages` is `[{ dir, pkg }]` for the whole publish set (post-bump).
 * Returns `Map<dir, requires>` for the packages that get one.
 */
export function computeStamps({ packages, serverVersion, wrapperMinimums }) {
  const stamps = new Map()
  const addonVersions = {}
  for (const { dir, pkg } of packages) {
    if (dir === SERVER_DIR || pkg.private === true || !isAddon(pkg)) continue
    stamps.set(dir, { ...(pkg.camstack.requires ?? {}), server: `>=${serverVersion}` })
    addonVersions[pkg.name] = `>=${pkg.version}`
  }
  const server = packages.find((entry) => entry.dir === SERVER_DIR)
  if (server !== undefined) {
    stamps.set(SERVER_DIR, {
      ...(server.pkg.camstack?.requires ?? {}),
      addons: addonVersions,
      wrapper: wrapperMinimums,
    })
  }
  return stamps
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/** Writes the stamp into `<dir>/package.json`; returns whether the file changed. */
export function applyStamp(dir, requires, root = '.') {
  const file = path.join(root, dir, 'package.json')
  const pkg = readJson(file)
  const before = JSON.stringify(pkg.camstack?.requires ?? null)
  if (before === JSON.stringify(requires)) return false
  pkg.camstack = { ...(pkg.camstack ?? {}), requires }
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  return true
}

function main() {
  const dirs = (process.argv[2] ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
  if (dirs.length === 0) {
    console.log('stamp-requires: empty publish set, nothing to stamp')
    return
  }
  const packages = dirs.map((dir) => ({ dir, pkg: readJson(path.join(dir, 'package.json')) }))
  const serverVersion = readJson(path.join(SERVER_DIR, 'package.json')).version
  const wrapperMinimums = readJson(WRAPPER_MINIMUMS_FILE)
  for (const [dir, requires] of computeStamps({ packages, serverVersion, wrapperMinimums })) {
    const changed = applyStamp(dir, requires)
    console.log(`stamp-requires: ${dir} ${changed ? 'stamped' : 'unchanged'} ${JSON.stringify(requires)}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
