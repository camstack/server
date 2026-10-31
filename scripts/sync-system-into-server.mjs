#!/usr/bin/env node
/**
 * Ship the built `packages/system` (private workspace `@camstack/server-framework`)
 * INSIDE the `@camstack/server` package, as `@camstack/server/system` (D-fold).
 *
 *   packages/system/{dist,assets}  ->  server/backend/system/{dist,assets}
 *   packages/system/package.json   ->  server/backend/system/package.json
 *
 * The generated `system/package.json` is the BUILTINS manifest the addon loader
 * reads (`camstack.addons`, entries relative to `system/`). It carries the
 * package name `@camstack/server` and the server's own version: the builtins are
 * the server's, there is no second package and no second version.
 *
 * `server/backend/system/` is build output (gitignored); `files` in the server
 * manifest ships it. Idempotent — run after `packages/system` builds and again
 * from the server build, so a pack always carries the current dist.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(repoRoot, 'packages', 'system')
const serverDir = path.join(repoRoot, 'server', 'backend')
const dstDir = path.join(serverDir, 'system')

export function buildBuiltinsManifest(systemManifest, serverManifest) {
  const camstack = systemManifest.camstack ?? {}
  return {
    name: serverManifest.name,
    version: serverManifest.version,
    description: 'CamStack builtins — shipped inside @camstack/server (generated, do not edit)',
    license: serverManifest.license,
    camstack,
  }
}

export function syncSystemIntoServer() {
  const distSrc = path.join(srcDir, 'dist')
  if (!fs.existsSync(path.join(distSrc, 'addon-runner.js'))) {
    throw new Error(
      `sync-system-into-server: ${distSrc}/addon-runner.js is missing — build packages/system first`,
    )
  }
  const systemManifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf-8'))
  const serverManifest = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf-8'))
  fs.rmSync(dstDir, { recursive: true, force: true })
  fs.mkdirSync(dstDir, { recursive: true })
  fs.cpSync(distSrc, path.join(dstDir, 'dist'), { recursive: true })
  const assetsSrc = path.join(srcDir, 'assets')
  if (fs.existsSync(assetsSrc)) fs.cpSync(assetsSrc, path.join(dstDir, 'assets'), { recursive: true })
  fs.writeFileSync(
    path.join(dstDir, 'package.json'),
    `${JSON.stringify(buildBuiltinsManifest(systemManifest, serverManifest), null, 2)}\n`,
  )
  console.log(`synced packages/system -> ${path.relative(repoRoot, dstDir)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncSystemIntoServer()
}
