#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- TECH-DEBT(test-2026-03-31): test/script file */
/**
 * Bundle required addon packages for production (Docker, binary builds).
 *
 * For each package in REQUIRED_PACKAGES:
 *   1. Finds it in the workspace (packages/)
 *   2. Builds it if dist/ is missing
 *   3. Copies dist/ + package.json → target/addons/@camstack/X/
 *   4. Writes .install-source = "bundled"
 *
 * Usage:
 *   npx tsx scripts/bundle-addons.ts [--target <dir>]
 *   Default target: build/addons
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(__dirname, '..')
const PACKAGES_DIR = path.join(ROOT, 'packages')
const DEFAULT_TARGET = path.join(ROOT, 'build', 'addons')

// Parse args
const args = process.argv.slice(2)
const targetIdx = args.indexOf('--target')
const targetDir =
  targetIdx >= 0 && args[targetIdx + 1] ? path.resolve(args[targetIdx + 1]) : DEFAULT_TARGET

// Import REQUIRED_PACKAGES from system (kernel absorbed into @camstack/system)
const { AddonInstaller } = require(
  path.join(ROOT, 'packages/system/dist/kernel/index.js'),
) as typeof import('@camstack/system')
const REQUIRED_PACKAGES = AddonInstaller.REQUIRED_PACKAGES

console.log(`Bundling ${REQUIRED_PACKAGES.length} required packages → ${targetDir}\n`)

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function copyDirRecursive(src: string, dest: string): void {
  ensureDir(dest)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function stripCamstackDeps(pkg: Record<string, unknown>): Record<string, unknown> {
  const result = { ...pkg }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = result[field] as Record<string, string> | undefined
    if (!deps) continue
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(deps)) {
      if (!key.startsWith('@camstack/')) {
        filtered[key] = value
      }
    }
    result[field] = Object.keys(filtered).length > 0 ? filtered : undefined
  }
  return result
}

let success = 0
let failed = 0

for (const packageName of REQUIRED_PACKAGES) {
  const shortName = packageName.replace('@camstack/', '')
  const sourceDir = path.join(PACKAGES_DIR, shortName)
  const sourcePkgJson = path.join(sourceDir, 'package.json')

  if (!fs.existsSync(sourcePkgJson)) {
    console.error(`  SKIP ${packageName} — not found in workspace at ${sourceDir}`)
    failed++
    continue
  }

  const distDir = path.join(sourceDir, 'dist')
  if (!fs.existsSync(distDir)) {
    console.log(`  BUILD ${packageName}...`)
    try {
      execFileSync('npm', ['run', 'build', '-w', `packages/${shortName}`], {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 120_000,
      })
    } catch (err) {
      console.error(
        `  FAIL ${packageName} — build failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      failed++
      continue
    }
  }

  const addonTargetDir = path.join(targetDir, packageName)
  fs.rmSync(addonTargetDir, { recursive: true, force: true })
  ensureDir(addonTargetDir)

  // Copy package.json (stripped)
  const pkgData = JSON.parse(fs.readFileSync(sourcePkgJson, 'utf-8'))
  const stripped = stripCamstackDeps(pkgData)
  fs.writeFileSync(path.join(addonTargetDir, 'package.json'), JSON.stringify(stripped, null, 2))

  // Copy dist/
  copyDirRecursive(distDir, path.join(addonTargetDir, 'dist'))

  // Copy extra dirs from "files" field
  const files = pkgData.files as string[] | undefined
  if (files) {
    for (const f of files) {
      if (f === 'dist' || f === 'dist/') continue
      const srcExtra = path.join(sourceDir, f)
      if (fs.existsSync(srcExtra) && fs.statSync(srcExtra).isDirectory()) {
        copyDirRecursive(srcExtra, path.join(addonTargetDir, f))
      }
    }
  }

  // Mark as bundled
  fs.writeFileSync(path.join(addonTargetDir, '.install-source'), 'bundled')

  console.log(`  OK ${packageName} → ${addonTargetDir}`)
  success++
}

console.log(`\nDone: ${success} bundled, ${failed} failed`)
if (failed > 0) process.exit(1)
