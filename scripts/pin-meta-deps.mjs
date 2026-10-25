#!/usr/bin/env node
/**
 * pin-meta-deps — make a meta-package's @camstack/* dependencies reproducible.
 *
 * The meta-package (@camstack/server — the single root package for every
 * node role) declares its
 * @camstack/* deps as "*" so npm-workspaces links the local package during
 * development regardless of version. That "*" is ALSO what ships to npm, so
 * `npm install @camstack/server@latest` (the Docker image build) resolves each
 * addon to whatever is newest at build time — builds are not reproducible.
 *
 * This tool rewrites a meta-package.json's @camstack/* deps to the EXACT
 * versions currently declared by the workspace packages, so the published
 * tarball pins its transitive @camstack set.
 *
 * ── INTENDED USAGE (CI publish only) ──────────────────────────────────────
 * Run AFTER the version-bump step and IMMEDIATELY BEFORE `npm publish` of the
 * meta-package, then revert the file so the committed repo keeps "*" (exact
 * pins committed to the repo would break dev workspace linking on the next
 * local bump). e.g. in publish-packages.yml:
 *
 *     node scripts/pin-meta-deps.mjs server/backend/package.json
 *     # ... npm publish the meta ...
 *     git checkout -- server/backend/package.json
 *
 * Do NOT run this against your working tree and commit the result.
 *
 * The reproducibility decision and trade-offs are documented in
 * (planning repo: superpowers/specs/2026-06-17-unraid-deploy-readiness.md) (B1).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Read every workspace package's name → version from packages/ and server/.
 * @param {string} repoRoot
 * @returns {Map<string,string>}
 */
export function readWorkspaceVersions(repoRoot) {
  const versions = new Map()
  for (const root of ['packages', 'server']) {
    const dir = path.join(repoRoot, root)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pjPath = path.join(dir, entry.name, 'package.json')
      if (!fs.existsSync(pjPath)) continue
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
      if (pj.name && pj.version) versions.set(pj.name, pj.version)
    }
  }
  return versions
}

/**
 * Return a NEW dependencies object with every @camstack/* entry repinned to the
 * exact version from `versions`. Non-@camstack deps and @camstack deps with no
 * known workspace version are left untouched. Pure — does not mutate input.
 * @param {Record<string,string>|undefined} deps
 * @param {Map<string,string>} versions
 * @returns {{deps: Record<string,string>, pinned: string[], missing: string[]}}
 */
export function computePinnedDeps(deps, versions) {
  const out = {}
  const pinned = []
  const missing = []
  for (const [name, range] of Object.entries(deps ?? {})) {
    if (!name.startsWith('@camstack/')) {
      out[name] = range
      continue
    }
    const version = versions.get(name)
    if (version) {
      out[name] = version
      pinned.push(`${name}@${version}`)
    } else {
      out[name] = range
      missing.push(name)
    }
  }
  return { deps: out, pinned, missing }
}

/**
 * Pin a meta-package.json in place. Returns the pin report.
 * @param {string} metaPath
 * @param {string} repoRoot
 */
export function pinMetaPackage(metaPath, repoRoot) {
  const pj = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const versions = readWorkspaceVersions(repoRoot)
  const { deps, pinned, missing } = computePinnedDeps(pj.dependencies, versions)
  pj.dependencies = deps
  fs.writeFileSync(metaPath, JSON.stringify(pj, null, 2) + '\n')
  return { pinned, missing }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const metaArg = process.argv[2]
  if (!metaArg) {
    console.error('usage: node scripts/pin-meta-deps.mjs <path/to/meta/package.json>')
    process.exit(1)
  }
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const { pinned, missing } = pinMetaPackage(path.resolve(metaArg), repoRoot)
  console.log(`[pin-meta-deps] ${metaArg}: pinned ${pinned.length} @camstack dep(s)`)
  for (const p of pinned) console.log(`  ${p}`)
  if (missing.length > 0) {
    console.log(`[pin-meta-deps] left unpinned (no workspace version): ${missing.join(', ')}`)
  }
}
