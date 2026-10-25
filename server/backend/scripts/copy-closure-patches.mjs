#!/usr/bin/env node
/**
 * Build step: copy the `closure-postinstall` patches into
 * `server/backend/dist/closure-patches/` so they ship inside
 * `@camstack/server`'s tarball (`files: ["dist", ...]`). (D478)
 *
 * npm's `files` cannot reach outside the package directory and `patches/` lives
 * at the repo ROOT, which is the whole reason this step exists. The repo root
 * stays the single authority — nothing here is committed, the copy is build
 * output, and `scripts/check-patches-reach-production.ts` compares what shipped
 * against `patches/` byte for byte so the two cannot drift.
 *
 * Only `reach: "closure-postinstall"` patches are copied. A `bundled` patch is
 * already inside a dist and a `dev-only` one has nothing to reach, so shipping
 * either would be dead weight the applier has to skip at every install.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const PATCHES_DIR = path.join(REPO_ROOT, 'patches')
const OUT_DIR = path.resolve(HERE, '..', 'dist', 'closure-patches')
const MANIFEST = 'patch-reach.json'

const manifestPath = path.join(PATCHES_DIR, MANIFEST)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
const shipped = (manifest.patches ?? []).filter((p) => p.reach === 'closure-postinstall')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.copyFileSync(manifestPath, path.join(OUT_DIR, MANIFEST))
for (const entry of shipped) {
  const src = path.join(PATCHES_DIR, entry.patch)
  if (!fs.existsSync(src)) {
    throw new Error(`${MANIFEST} declares ${entry.patch}, which does not exist in patches/`)
  }
  fs.copyFileSync(src, path.join(OUT_DIR, entry.patch))
}
process.stdout.write(
  `copied ${String(shipped.length)} closure patch(es) + ${MANIFEST} -> dist/closure-patches\n`,
)
