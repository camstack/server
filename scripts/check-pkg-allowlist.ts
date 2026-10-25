#!/usr/bin/env tsx
/**
 * Privileged-helper allowlist drift (D326).
 *
 * The runner refuses unknown packages from `DISTRO_PACKAGE_ALLOWLIST`.
 * The root helper reads `scripts/docker/pkg-allowlist.json`. If they
 * disagree, an addon the runner admits is refused by the helper (or the
 * reverse: the helper would install something the runner never asked for).
 *
 * Usage: npx tsx scripts/check-pkg-allowlist.ts
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { DISTRO_PACKAGE_ALLOWLIST } from '../packages/system/src/kernel/deps/system-package-allowlist.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const JSON_PATH = path.join(ROOT, 'scripts/docker/pkg-allowlist.json')

interface AllowlistFile {
  readonly apt?: readonly string[]
  readonly apk?: readonly string[]
  readonly dnf?: readonly string[]
}

function main(): void {
  const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as AllowlistFile
  const problems: string[] = []
  for (const manager of ['apt', 'apk', 'dnf'] as const) {
    const fromJson = [...(raw[manager] ?? [])].toSorted()
    const fromTs = [...DISTRO_PACKAGE_ALLOWLIST[manager]].toSorted()
    if (JSON.stringify(fromJson) !== JSON.stringify(fromTs)) {
      problems.push(
        `${manager}: image JSON ${JSON.stringify(fromJson)} vs runner ${JSON.stringify(fromTs)}`,
      )
    }
  }
  if (problems.length > 0) {
    console.error('D326 allowlist drifted between the image helper and the runner:')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log('✔ pkg allowlist: image helper and runner agree')
}

main()
