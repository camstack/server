#!/usr/bin/env node
/**
 * stamp-requires — writes the minimum versions a release needs (D989) into the
 * package.json files being published, right after "Bump package versions".
 *
 *   node scripts/ci/stamp-requires.mjs <comma-separated package dirs>
 *
 *  - every ADDON package in the set   requires.server = ">=<server version>"
 *    (the server this build was cut against — it cannot be older than that).
 *  - an addon that declares PAGES also requires
 *    addons['@camstack/addon-admin-ui'] = ">=<admin-ui version>": a page remote
 *    does not bundle ui-library, the admin UI that mounts it provides it, so an
 *    older admin UI would mount the page into a library missing what it imports.
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
export const ADMIN_UI_PACKAGE = '@camstack/addon-admin-ui'

const WRAPPER_MINIMUMS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'wrapper-minimums.json',
)

/** A package is an addon when it declares addon entries. */
function isAddon(pkg) {
  return typeof pkg.camstack === 'object' && pkg.camstack !== null && 'addons' in pkg.camstack
}

/** An addon contributes pages (Module Federation remotes mounted by the admin UI). */
function declaresPages(pkg) {
  const addons = pkg.camstack?.addons
  return Array.isArray(addons) && addons.some((a) => Array.isArray(a?.pages) && a.pages.length > 0)
}

/**
 * Pure: the `requires` block each published package should carry.
 * `packages` is `[{ dir, pkg }]` for the whole publish set (post-bump).
 * Returns `Map<dir, requires>` for the packages that get one.
 */
export function computeStamps({ packages, serverVersion, wrapperMinimums, adminUiVersion }) {
  const stamps = new Map()
  const addonVersions = {}
  for (const { dir, pkg } of packages) {
    if (dir === SERVER_DIR || pkg.private === true || !isAddon(pkg)) continue
    const requires = { ...(pkg.camstack.requires ?? {}), server: `>=${serverVersion}` }
    if (declaresPages(pkg) && pkg.name !== ADMIN_UI_PACKAGE && adminUiVersion !== undefined) {
      requires.addons = { ...(requires.addons ?? {}), [ADMIN_UI_PACKAGE]: `>=${adminUiVersion}` }
    }
    stamps.set(dir, requires)
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
  // The admin UI as this batch leaves it: its new version when it is in the set, else the one on disk.
  const adminUi = packages.find((entry) => entry.pkg.name === ADMIN_UI_PACKAGE)
  const adminUiVersion =
    adminUi?.pkg.version ??
    readJson(path.join('packages', 'addon-admin-ui', 'package.json')).version
  for (const [dir, requires] of computeStamps({
    packages,
    serverVersion,
    wrapperMinimums,
    adminUiVersion,
  })) {
    const changed = applyStamp(dir, requires)
    console.log(
      `stamp-requires: ${dir} ${changed ? 'stamped' : 'unchanged'} ${JSON.stringify(requires)}`,
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
