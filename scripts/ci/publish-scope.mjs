#!/usr/bin/env node
/**
 * publish-scope — which packages a set of changed files must publish.
 *
 * Extracted from the publish workflow on 2026-09-17, after the inline version
 * shipped a `ui-library` change that reached the registry, reached every node,
 * and changed NOTHING in the browser. Three rules, each bought with a release
 * that looked green:
 *
 *  1. **Direct.** A package whose own files changed.
 *  2. **Bundled-into.** A package that compiles another package's SOURCE into
 *     its own artifact must be rebuilt when that source changes — it holds a
 *     COPY, not a dependency. `addon-admin-ui` aliases `@camstack/ui-library`
 *     to `../ui-library/src` in its vite config, so a published ui-library is
 *     invisible to the browser until the admin UI is rebuilt. Derived by
 *     reading the build configs, not from a list, because a list of who
 *     bundles whom is exactly the thing that goes stale.
 *
 *     A copy has two forms in this repo, and the first version of this rule
 *     knew one of them. `@camstack/system` sets `bundleTypesMainEntry: true`
 *     (`tools/build/vite-lib.preset.ts`) and so INLINES the bare
 *     `@camstack/types` entry — the cap definitions every tRPC router
 *     validates against — into its own dist; the hub sources them from there,
 *     never from `@camstack/types`. That form names no `../types/src`, so on
 *     2026-09-19 `event-saving` reached `types@1.2.229…231` through five runs
 *     and `system` stayed at 1.2.273, built the evening before: every
 *     `setCameraSwitch` on the fleet was refused with an eight-id enum while
 *     the types package next to it carried nine (D545). The derivation now
 *     reads the preset flag too, and `scripts/check-inlined-sources-known.ts`
 *     proves against the BUILT dists that no third form exists unknown to it.
 *  3. **Closure.** Anything `@camstack/server` depends on drags
 *     `@camstack/server` with it: the server is the only package published with
 *     exact pins, so a closure member reaches a node through a new server and
 *     through nothing else.
 *
 * A package this module adds ONLY because it bundles another package's source
 * is a candidate, not a decision. `publish-output.mjs` publishes it when the
 * built tarball differs from the registry and drops it when the bytes match
 * (run 40374002262 republished five UI addons whose bundles do not contain
 * the ui-library edit). `resolvePublishSet` still returns the full cascade —
 * the set that must be BUILT so the comparison has something to hash.
 *
 * Usage:
 *   node scripts/ci/publish-scope.mjs <comma-separated changed files>
 *   → prints the comma-separated package DIRECTORIES to publish
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const WORKSPACE_ROOTS = ['packages', 'server']
/**
 * Which files can carry a bundle-time alias.
 *
 * Every `*.config.*` at the package root, not a named list: the first version
 * of this listed `vite.config.ts`, `vite.lib.config.ts` and `tsup.config.ts`
 * and missed `vite.page.config.ts` — model-studio and osd-manager bundle
 * ui-library through that one, and a list of build-config filenames goes stale
 * exactly like the list of who-bundles-whom it was meant to replace.
 */
const BUILD_CONFIG_PATTERN = /^[a-z0-9.-]*config\.(ts|mts|js|mjs)$/

/** dir → package.json, for every workspace package. */
export function readWorkspace(root = process.cwd()) {
  const packages = new Map()
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const full = path.join(root, workspaceRoot)
    if (!fs.existsSync(full)) continue
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(workspaceRoot, entry.dir ?? '', entry.name).replace(/\\/g, '/')
      const pjPath = path.join(root, dir, 'package.json')
      if (!fs.existsSync(pjPath)) continue
      packages.set(dir, JSON.parse(fs.readFileSync(pjPath, 'utf-8')))
    }
  }
  return packages
}

/**
 * A build-config line that makes the preset inline the bare `@camstack/types`
 * entry. Matched on the option NAME, not on a path: the option is the
 * instruction, and it lives in the package's own config.
 */
const BUNDLE_TYPES_MAIN_ENTRY_PATTERN = /\bbundleTypesMainEntry\s*:\s*true\b/

/**
 * A build-config line that picks the preset's self-contained externals. Those
 * externals do NOT keep `@camstack/types` outside the bundle
 * (`SELF_CONTAINED_EXTERNALS` in `tools/build/vite-lib.preset.ts`), so every
 * such addon's dist carries a PRIVATE copy of the cap definitions: used by the
 * addon's own code, never by the hub's routers. See `inlinedSources`.
 */
const SELF_CONTAINED_EXTERNALS_PATTERN = /\bexternals\s*:\s*['"]self-contained(?:\+ui)?['"]/

/**
 * A `noExternal` list naming a workspace package: the bundler is told to
 * inline it. `server/backend` inlines the private `@camstack/node-root`.
 */
const NO_EXTERNAL_PATTERN = /\bnoExternal\s*:\s*\[([^\]]*)\]/g
const CAMSTACK_NAME_PATTERN = /@camstack\\?\/([a-z0-9-]+)/g

const TYPES_DIR = 'packages/types'

/** dir → workspace dir, for a `@camstack/<name>` seen in a config or manifest. */
function dirOfName(packages, name) {
  for (const [dir, pj] of packages) if (pj.name === `@camstack/${name}`) return dir
  return null
}

/**
 * tsup inlines every import it is not told to keep external, and it keeps
 * external exactly the package's `dependencies` + `peerDependencies` (plus the
 * config's `external`). A workspace package it declares only under
 * `devDependencies` is therefore bundled, and so is everything that package
 * imports which is not a dependency either: the CLI carries `types`,
 * `server/backend`, `system` and `node-root` this way. What tsup reaches is
 * not readable from the config, so the declaration is tsup's own rule — every
 * workspace package that is not a dependency — and the artifact guard tells
 * which of those are real. Private: nothing outside the CLI reads them.
 */
function tsupReachable(dir, pj, packages) {
  const declared = new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
  ])
  const dev = Object.keys(pj.devDependencies ?? {}).filter(
    (name) => name.startsWith('@camstack/') && !declared.has(name),
  )
  if (dev.length === 0) return []
  return [...packages.keys()].filter(
    (other) => other !== dir && !declared.has(packages.get(other).name),
  )
}

/**
 * dir → target dir → `'authoritative' | 'private'`, for every workspace
 * package whose artifact carries a COPY of another package's source.
 *
 * Read from the build configs at the package root, in every form this repo
 * uses:
 *
 *   - `'../<name>/src'` — a bundler told to take the source, not the published
 *     artifact. **authoritative**: the copy IS what the consumer runs
 *     (admin-ui's browser bundle of ui-library).
 *   - `bundleTypesMainEntry: true` — the preset inlines the bare
 *     `@camstack/types` entry. **authoritative**: `@camstack/system` builds
 *     the cap routers from that copy, so it is the cluster's API surface.
 *   - `externals: 'self-contained'` / `'self-contained+ui'` — the preset
 *     inlines `@camstack/types` along with every other pure-JS dependency.
 *     **private**: the copy validates only what the addon itself parses; the
 *     hub never reads it. Declared here so the artifact guard can tell a
 *     known private copy from an unknown one, and so the cascade policy is
 *     one line (`bundledSources`) rather than folklore.
 *   - `noExternal: [… '@camstack/<name>' …]` — a bundler told to inline a
 *     workspace package by name (server/backend → node-root). **private**.
 *   - a `tsup.config.*` in a package that declares `@camstack/*` only under
 *     `devDependencies` — tsup bundles those and what they reach (the CLI).
 *     **private**, declared as tsup's own rule: every workspace package that
 *     is not a dependency (`tsupReachable`).
 *
 * Kinds are ordered: a package with both an alias and a self-contained mode
 * is authoritative for that target.
 */
export function inlinedSources(root = process.cwd(), packages = readWorkspace(root)) {
  const map = new Map()
  const record = (dir, target, kind) => {
    if (!packages.has(target) || target === dir) return
    let targets = map.get(dir)
    if (targets === undefined) {
      targets = new Map()
      map.set(dir, targets)
    }
    if (targets.get(target) !== 'authoritative') targets.set(target, kind)
  }
  for (const dir of packages.keys()) {
    const packageRoot = path.join(root, dir)
    const configs = fs.existsSync(packageRoot)
      ? fs.readdirSync(packageRoot).filter((name) => BUILD_CONFIG_PATTERN.test(name))
      : []
    for (const config of configs) {
      const text = fs.readFileSync(path.join(packageRoot, config), 'utf-8')
      // `'../ui-library/src'` and `'../ui-library/src/index.ts'` are the same
      // instruction: take the SOURCE, not the published artifact.
      for (const match of text.matchAll(/['"]\.\.\/([a-z0-9-]+)\/src(?:\/[^'"]*)?['"]/g)) {
        record(dir, `packages/${match[1]}`, 'authoritative')
      }
      if (BUNDLE_TYPES_MAIN_ENTRY_PATTERN.test(text)) record(dir, TYPES_DIR, 'authoritative')
      if (SELF_CONTAINED_EXTERNALS_PATTERN.test(text)) record(dir, TYPES_DIR, 'private')
      for (const list of text.matchAll(NO_EXTERNAL_PATTERN)) {
        for (const name of list[1].matchAll(CAMSTACK_NAME_PATTERN)) {
          const target = dirOfName(packages, name[1])
          if (target !== null) record(dir, target, 'private')
        }
      }
      if (/^tsup\.config\./.test(config)) {
        for (const target of tsupReachable(dir, packages.get(dir), packages))
          record(dir, target, 'private')
      }
    }
  }
  return map
}

/**
 * dir → the package dirs whose SOURCE it compiles in AND must be republished
 * with: the authoritative copies from `inlinedSources`. A private copy is
 * deliberately not here — cascading it would republish forty addons on every
 * `types` edit for a copy nothing outside the addon reads (D545 records the
 * choice; flipping it is this filter).
 */
export function bundledSources(root = process.cwd(), packages = readWorkspace(root)) {
  const map = new Map()
  for (const [dir, targets] of inlinedSources(root, packages)) {
    const authoritative = new Set(
      [...targets].filter(([, kind]) => kind === 'authoritative').map(([target]) => target),
    )
    if (authoritative.size > 0) map.set(dir, authoritative)
  }
  return map
}

/** The package dir a changed file belongs to, or `null`. */
function ownerOf(file) {
  const match = /^(packages\/[^/]+|server\/[^/]+)\//.exec(file)
  return match === null ? null : match[1]
}

/** Package dirs whose own files are in `changedFiles`, private included. */
export function directOwners(changedFiles, root = process.cwd()) {
  const packages = readWorkspace(root)
  const direct = []
  const seen = new Set()
  for (const file of changedFiles) {
    const dir = ownerOf(file)
    if (dir === null || !packages.has(dir) || seen.has(dir)) continue
    seen.add(dir)
    direct.push(dir)
  }
  return direct
}

function serverPackageDir(packages) {
  return [...packages].find(([, pj]) => pj.name === '@camstack/server')?.[0]
}

/** Names `@camstack/server` pins. Empty when the workspace has no server. */
function serverClosureNames(packages) {
  const server = [...packages].find(([, pj]) => pj.name === '@camstack/server')
  if (server === undefined) return new Set()
  return new Set(
    Object.keys(server[1].dependencies ?? {}).filter((name) => name.startsWith('@camstack/')),
  )
}

/**
 * The two cascades, applied to a set of package DIRS.
 *
 * Exported separately because the workflow reaches this set two ways — from
 * changed files (the affected path) and from `force_packages` / `scope=all` —
 * and both need the same answer. A second copy of the rules in the YAML is how
 * the first version of the closure cascade ended up covering `@camstack/system`
 * and nothing else for a month.
 */
export function applyCascades(dirs, root = process.cwd()) {
  const packages = readWorkspace(root)
  const bundles = bundledSources(root, packages)
  const selected = new Set([...dirs].filter((dir) => packages.has(dir)))

  // Bundled-into, to a fixed point: a bundler of a bundler rebuilds too.
  for (;;) {
    let grew = false
    for (const [dir, targets] of bundles) {
      if (selected.has(dir)) continue
      for (const target of targets) {
        if (selected.has(target)) {
          selected.add(dir)
          grew = true
          break
        }
      }
    }
    if (!grew) break
  }

  // Closure → server.
  const serverDir = [...packages].find(([, pj]) => pj.name === '@camstack/server')?.[0]
  if (serverDir !== undefined) {
    const closure = new Set(
      Object.keys(packages.get(serverDir).dependencies ?? {}).filter((name) =>
        name.startsWith('@camstack/'),
      ),
    )
    if ([...selected].some((dir) => closure.has(packages.get(dir).name))) selected.add(serverDir)
  }

  return orderForPublish([...selected].filter((dir) => packages.get(dir).private !== true))
}

/**
 * Publish order for the npm loop. `@camstack/server` is ALWAYS last: its
 * publish step waits until every pinned `@camstack/*` version is installable
 * from the registry, so anything listed after it in the same loop can never
 * satisfy that wait.
 *
 * 2026-10-04 run 37223477606 (`scope=all`): `nx show projects` order put
 * `server/backend` before `packages/types` and `packages/sdk`. The closure
 * gate slept 30 min × 2 on pins this run had not published yet, then refused
 * the server. Alphabetical `.sort()` happened to put server last too, but
 * the workflow discarded that order by re-adding into a Set — this helper
 * names the invariant so a rename cannot quietly break it.
 */
export function orderForPublish(dirs) {
  const unique = [...new Set(dirs)]
  const rest = unique.filter((dir) => dir !== 'server/backend').sort()
  return unique.includes('server/backend') ? [...rest, 'server/backend'] : rest
}

/**
 * The closure pins that would ship a STALE copy: members of `@camstack/server`'s
 * dependency closure that are NOT in this run's publish set (so the closure
 * pins the version already on the registry) but whose artifact carries an
 * authoritative copy of a package that IS being published.
 *
 * This is the 2026-09-19 failure stated as a question: `types` published,
 * `system` pinned from npm, the pinned `system` carrying the previous `types`.
 * `applyCascades` prevents it on every path the workflow has; this is asked
 * again at pin time, from the FINAL set, because the set can be narrowed after
 * the cascade (the viewer gate drops the orchestrator) and because a resolver
 * blind spot is exactly what put the wrong `system` on the hub.
 *
 * Returns `[{ pinned, publishes }]`, empty when the closure is consistent.
 *
 * `verifiedUnchanged` is the exception the output check earns: a candidate
 * whose built tarball matches the registry is not a stale copy of what this
 * run publishes — the bytes were compared. Pinning it at the registry
 * version is the point of dropping it. Passing a dir here without that
 * comparison re-opens 2026-09-19.
 */
export function staleRegistryPins(publishDirs, root = process.cwd(), options = {}) {
  const packages = readWorkspace(root)
  const publishing = new Set([...publishDirs].filter((dir) => packages.has(dir)))
  const verified = new Set(options.verifiedUnchanged ?? [])
  const serverEntry = [...packages].find(([, pj]) => pj.name === '@camstack/server')
  if (serverEntry === undefined) return []
  const closureNames = serverClosureNames(packages)
  const bundles = bundledSources(root, packages)
  const stale = []
  for (const [dir, pj] of packages) {
    if (!closureNames.has(pj.name) || publishing.has(dir) || verified.has(dir)) continue
    for (const target of bundles.get(dir) ?? []) {
      if (publishing.has(target)) stale.push({ pinned: dir, publishes: target })
    }
  }
  return stale.sort(
    (a, b) => a.pinned.localeCompare(b.pinned) || a.publishes.localeCompare(b.publishes),
  )
}

export function resolvePublishSet(changedFiles, root = process.cwd()) {
  return applyCascades(directOwners(changedFiles, root), root)
}

/**
 * Split the cascade into packages that publish unconditionally and packages
 * selected ONLY because they bundle something in that set.
 *
 * `dirs` is the pre-cascade set: own files, `force_packages`, nx dependents,
 * `scope=all`. Those publish. A bundler `applyCascades` adds on top of them
 * is a candidate (`publish-output.mjs` keeps it only when the built output
 * differs). The server is never a candidate — a closure member reaches a
 * node through it, or it was named directly.
 */
export function partitionPublishSet(dirs, root = process.cwd()) {
  const packages = readWorkspace(root)
  const known = [...new Set(dirs)].filter((dir) => packages.has(dir))
  const all = applyCascades(known, root)
  const inputPublic = new Set(known.filter((dir) => packages.get(dir).private !== true))
  const server = serverPackageDir(packages)
  const candidates = all.filter((dir) => !inputPublic.has(dir) && dir !== server)
  const keep = all.filter((dir) => inputPublic.has(dir) || dir === server)
  const serverFromClosure = server !== undefined && all.includes(server) && !inputPublic.has(server)
  return { keep, candidates, all, serverFromClosure }
}

/**
 * Drop candidates that are not in `changedCandidates`. When the server was
 * pulled in only by the closure and nothing left in the set is a closure
 * member, drop the server too — its pins would not change.
 */
export function finalizePublishSet(partition, changedCandidates, root = process.cwd()) {
  const packages = readWorkspace(root)
  const changed = changedCandidates instanceof Set ? changedCandidates : new Set(changedCandidates)
  const server = serverPackageDir(packages)
  const dropped = []
  const selected = []
  for (const dir of partition.keep) {
    if (dir === server) continue
    selected.push(dir)
  }
  for (const dir of partition.candidates) {
    if (changed.has(dir)) selected.push(dir)
    else dropped.push(dir)
  }
  if (server !== undefined && partition.keep.includes(server)) {
    const closure = serverClosureNames(packages)
    const stillNeeded =
      !partition.serverFromClosure || selected.some((dir) => closure.has(packages.get(dir)?.name))
    if (stillNeeded) selected.push(server)
    else dropped.push(server)
  }
  return { publish: orderForPublish(selected), dropped }
}

const invokedDirectly = process.argv[1]?.endsWith('publish-scope.mjs') === true
if (invokedDirectly) {
  const files = (process.argv[2] ?? '').split(',').filter(Boolean)
  console.log(resolvePublishSet(files).join(','))
}
