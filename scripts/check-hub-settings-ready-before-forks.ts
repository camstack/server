#!/usr/bin/env tsx
/**
 * Forked addons may `resolveConfig()` only after the isolated sqlite engine
 * is in the parent's collection AND the in-process settings-store door has
 * booted. The sequence lives in `runHubAddonBoot` — this guard fails if the
 * hub registry stops calling it and inlines a different order.
 *
 * ## The failure this catches
 *
 * 2026-08-25: sqlite isolate spawned, then every other runner (including
 * cloudflare-tunnel) initialised against constructor defaults because the
 * door was not up yet. The tunnel auto-started quick (`*.trycloudflare.com`);
 * notifications still minted `camstack.<local-user>.top`; Cloudflare
 * answered 530 / error 1033 on every attachment URL.
 *
 * Usage: tsx scripts/check-hub-settings-ready-before-forks.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const REGISTRY = 'server/backend/src/core/addon/addon-registry.service.ts'
const HELPER = 'packages/system/src/kernel/isolated-builtin-phase.ts'

function fail(msg: string): never {
  console.error(`check-hub-settings-ready-before-forks: ${msg}`)
  process.exit(1)
}

const registry = fs.readFileSync(path.join(ROOT, REGISTRY), 'utf8')
const helper = fs.readFileSync(path.join(ROOT, HELPER), 'utf8')

if (!helper.includes('export async function runHubAddonBoot')) {
  fail(`${HELPER} must export runHubAddonBoot — that function IS the boot order`)
}
if (!registry.includes('runHubAddonBoot(')) {
  fail(`${REGISTRY} must call runHubAddonBoot() — do not inline a different wave order`)
}

console.log('check-hub-settings-ready-before-forks: ok')
