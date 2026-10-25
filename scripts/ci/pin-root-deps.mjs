#!/usr/bin/env node
/**
 * pin-root-deps — publish-time dependency pinning for the ROOT package
 * (@camstack/server — the single root package for every node role).
 *
 * The workspace files declare every @camstack/* dependency as "*" so local
 * dev always links the workspace copy. But a PUBLISHED root package with "*"
 * deps makes the staged closure resolve to "latest-of-everything at install
 * time" — applyServerUpdate / Docker builds stop being reproducible
 * checkpoints. So: pin the published ARTIFACT, keep "*" in the workspace.
 *
 *   node scripts/ci/pin-root-deps.mjs pin      # before `npm publish`
 *   node scripts/ci/pin-root-deps.mjs restore  # after publish (if: always())
 *
 * pin: rewrites each "*" @camstack/* dependency to the exact version of that
 *      package in THIS checkout (post-bump — the same run's publish set), and
 *      saves the original file as package.json.prepin.
 * restore: puts the original dependencies back (keeping the bumped version)
 *      and removes the .prepin file — the self-hosted runner workspace and
 *      the version-bump commit both stay pin-free.
 *
 * See (planning repo: superpowers/specs/2026-07-13-release-checkpoint-and-update-path-design.md) §A3.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { staleRegistryPins } from './publish-scope.mjs'

const ROOT_PACKAGES = ['server/backend']
const WORKSPACE_ROOTS = ['packages', 'server']

/**
 * Dirs actually being published THIS run (comma-separated, optionally set by
 * the workflow — the viewer gate can drop the orchestrator from the set).
 * A dep in the set pins to its (post-bump) workspace version; a dep OUTSIDE
 * the set pins to the version already ON npm — pinning an unpublished bump
 * would make the closure unresolvable.
 */
const publishSet = new Set(
  (process.env.PUBLISH_SET ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
)

function npmLatestVersion(name) {
  try {
    return execFileSync('npm', ['view', name, 'version'], { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

const mode = process.argv[2]
if (mode !== 'pin' && mode !== 'restore') {
  console.error('Usage: pin-root-deps.mjs pin|restore')
  process.exit(1)
}

/** name → { version, dir } for every workspace package (post-bump). */
function buildWorkspaceIndex() {
  const index = new Map()
  for (const root of WORKSPACE_ROOTS) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const pjPath = path.join(dir, 'package.json')
      if (!fs.existsSync(pjPath)) continue
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf-8'))
      if (pj.name) index.set(pj.name, { version: pj.version, dir })
    }
  }
  return index
}

/**
 * The version the published root must pin for `dep`:
 *   • dep publishes this run (or no publish set was provided) → its
 *     workspace version (== what lands on npm in this run);
 *   • otherwise → the version already on npm (fall back to workspace if
 *     the registry lookup fails — best effort beats an unresolvable pin).
 */
function resolvePinnedVersion(dep, entry) {
  if (publishSet.size === 0 || publishSet.has(entry.dir)) return entry.version
  return npmLatestVersion(dep) ?? entry.version
}

/**
 * A pin taken from the REGISTRY must not carry a stale copy of a package this
 * run publishes. On 2026-09-19 the closure pinned `@camstack/types@1.2.231`
 * next to `@camstack/system@1.2.273 (npm — not in this publish set)`, and the
 * `system` on the registry had inlined the previous day's `types`: every
 * `setCameraSwitch` on the fleet was refused with an eight-id enum while the
 * types package beside it carried nine (D545). The scope cascade now includes
 * such a bundler; this asks the same question of the FINAL set, at the one
 * step that knows which pins come from npm, and refuses rather than ship a
 * closure that disagrees with itself.
 */
function refuseStalePins() {
  if (publishSet.size === 0) return
  const stale = staleRegistryPins([...publishSet])
  if (stale.length === 0) return
  for (const { pinned, publishes } of stale) {
    console.error(
      `::error::pin-root-deps: ${pinned} is pinned from the registry but its artifact carries a copy of ${publishes}, which this run publishes — the closure would ship a ${pinned} built against the PREVIOUS ${publishes}. Add ${pinned} to the publish set (force_packages) or fix the scope cascade.`,
    )
  }
  process.exit(1)
}

function pin() {
  refuseStalePins()
  const index = buildWorkspaceIndex()
  for (const dir of ROOT_PACKAGES) {
    const pjPath = path.join(dir, 'package.json')
    const prepinPath = `${pjPath}.prepin`
    const raw = fs.readFileSync(pjPath, 'utf-8')
    const pj = JSON.parse(raw)
    const pinned = {}
    let count = 0
    for (const [dep, spec] of Object.entries(pj.dependencies ?? {})) {
      if (dep.startsWith('@camstack/') && spec === '*') {
        const entry = index.get(dep)
        if (!entry) {
          console.error(`::error::pin-root-deps: ${dep} (dep of ${pj.name}) not found in workspace`)
          process.exit(1)
        }
        const version = resolvePinnedVersion(dep, entry)
        pinned[dep] = version
        count += 1
        console.log(
          `  ${pj.name}: ${dep} → ${version}${publishSet.size > 0 && !publishSet.has(entry.dir) ? ' (npm — not in this publish set)' : ''}`,
        )
      } else {
        pinned[dep] = spec
      }
    }
    fs.writeFileSync(prepinPath, raw)
    fs.writeFileSync(pjPath, `${JSON.stringify({ ...pj, dependencies: pinned }, null, 2)}\n`)
    console.log(`pinned ${count} @camstack/* deps in ${pj.name} (${dir})`)
  }
}

function restore() {
  for (const dir of ROOT_PACKAGES) {
    const pjPath = path.join(dir, 'package.json')
    const prepinPath = `${pjPath}.prepin`
    if (!fs.existsSync(prepinPath)) {
      console.log(`nothing to restore for ${dir} (no .prepin)`)
      continue
    }
    const current = JSON.parse(fs.readFileSync(pjPath, 'utf-8'))
    const original = JSON.parse(fs.readFileSync(prepinPath, 'utf-8'))
    fs.writeFileSync(
      pjPath,
      // Original file back verbatim EXCEPT the version, which keeps the bump
      // applied earlier in the run (the bump commit must record it).
      `${JSON.stringify({ ...original, version: current.version }, null, 2)}\n`,
    )
    fs.rmSync(prepinPath)
    console.log(`restored ${dir} dependencies (kept version ${current.version})`)
  }
}

if (mode === 'pin') pin()
else restore()
