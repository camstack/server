#!/usr/bin/env tsx
/**
 * Every tRPC cap path the routers expose must be IN `METHOD_ACCESS_MAP`.
 *
 * ## What this guards, and what it cost to learn
 *
 * The scope gate is skipped — not failed, SKIPPED — for a path the map does not
 * contain: `trpc.middleware.ts` reads `if (path in METHOD_ACCESS_MAP)` and a
 * miss falls through to whatever `adminProcedure` is chained on top. That is
 * deliberate, because a hand-written core route has no cap entry. It also means
 * a cap route missing from the map is a route with NO scope containment at all.
 *
 * `generate-method-access-map.ts` used to enumerate `capDef.methods`, the
 * DECLARED surface, while `generate-cap-routers.ts` emits the EFFECTIVE one —
 * `expandCapMethods`, which folds in `getStatus` and the three
 * `DeviceSettingsContribution` methods for every cap that declares a status
 * schema or `exposesDeviceSettings`. The two disagreed about 105 paths.
 * Measured 2026-09-21: 92 of them `protected`, i.e. per-device reads
 * (`battery.getStatus`, `cameraCredentials.getStatus`, every
 * `getDeviceLiveContribution`) that any authenticated non-admin could call for
 * ANY device, outside their grant. Nothing was wrong in the scope machinery;
 * the paths simply never reached it.
 *
 * Both generators now read the same expansion. This guard is what keeps them
 * reading it — a third consumer of a cap definition is exactly how the first
 * two drifted.
 *
 * ## Second check: auto-injected methods carry a device selector
 *
 * `generate-method-device-selectors.ts` repeated the same mistake (it spread
 * `capDef.methods`), so `battery.getStatus`, `motion.getStatus`,
 * `networkLink.getStatus` and every other injected method were in the access map
 * but had NO entry in `METHOD_DEVICE_SELECTORS`. `referencedDeviceIds` returned
 * [] and a non-admin holding `device:all[view]` got FORBIDDEN — the grant could
 * never match. Every method `expandCapMethods` ADDS to a device-scope cap takes
 * `deviceId`, so each must carry a single `deviceId` selector.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.js'
import { expandCapMethods } from '../packages/types/src/index.js'
import { METHOD_ACCESS_MAP } from '../packages/types/src/generated/method-access-map.js'
import { METHOD_DEVICE_SELECTORS } from '../packages/types/src/generated/method-device-selectors.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const API_REFERENCE = path.join(ROOT, 'docs/reference/api.md')

/** `| \`cap.method\` | query | protected | owning-cap |` */
const ROUTE_ROW =
  /^\|\s*`([a-zA-Z][\w]*\.[\w]+)`\s*\|\s*(?:query|mutation|subscription)\s*\|\s*(public|protected|admin|agent)\s*\|/

interface Route {
  readonly path: string
  readonly auth: string
}

function routesFromReference(): readonly Route[] {
  const out: Route[] = []
  for (const line of fs.readFileSync(API_REFERENCE, 'utf8').split('\n')) {
    const m = ROUTE_ROW.exec(line)
    if (m !== null) out.push({ path: m[1] ?? '', auth: m[2] ?? '' })
  }
  return out
}

function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** Paths `expandCapMethods` injects into a device-scope cap (absent from the
 *  cap's declared `methods`). */
async function injectedDeviceMethodPaths(): Promise<readonly string[]> {
  const out: string[] = []
  for (const file of fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))) {
    const mod: Record<string, unknown> = await import(path.join(CAPS_DIR, file))
    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (exportName === undefined) continue
    const capDef = mod[exportName] as CapabilityDefinition
    if (capDef.scope !== 'device') continue
    const declared = new Set(Object.keys(capDef.methods))
    for (const name of Object.keys(expandCapMethods(capDef))) {
      if (!declared.has(name)) out.push(`${kebabToCamel(capDef.name)}.${name}`)
    }
  }
  return out
}

async function checkInjectedSelectors(): Promise<void> {
  const injected = await injectedDeviceMethodPaths()
  if (injected.length === 0) {
    console.error('✗ found no auto-injected device-scope methods — the check itself is broken')
    process.exit(1)
  }
  const bad = injected.filter((p) => {
    const fields = METHOD_DEVICE_SELECTORS[p]
    return !fields?.some((f) => f.name === 'deviceId' && f.form === 'single')
  })
  if (bad.length > 0) {
    console.error(
      `✗ ${bad.length} auto-injected device-scope method(s) have no single \`deviceId\` entry in METHOD_DEVICE_SELECTORS,` +
        '\n  so a device grant can never match them (FORBIDDEN for `device:all[view]`):\n',
    )
    for (const p of bad.slice(0, 20)) console.error(`  ${p}`)
    if (bad.length > 20) console.error(`  … and ${bad.length - 20} more`)
    console.error(
      '\nRun `npm run codegen`. If they are still missing, `generate-method-device-selectors.ts` is not' +
        '\nreading `expandCapMethods` — it must, exactly like `generate-method-access-map.ts`.',
    )
    process.exit(1)
  }
  console.log(
    `✓ all ${injected.length} auto-injected device-scope methods carry a deviceId selector`,
  )
}

async function main(): Promise<void> {
  const routes = routesFromReference()
  if (routes.length === 0) {
    console.error(
      '✗ no routes parsed out of docs/reference/api.md — run `npm run docs:generate` first',
    )
    process.exit(1)
  }

  const missing = routes.filter((r) => !(r.path in METHOD_ACCESS_MAP))
  if (missing.length > 0) {
    // `admin` ones are contained by the admin gate; the others are not
    // contained by anything, and that distinction is the whole severity.
    const unguarded = missing.filter((r) => r.auth !== 'admin')
    console.error(
      `✗ ${missing.length} tRPC cap path(s) are missing from METHOD_ACCESS_MAP, so the scope gate does not run for them\n`,
    )
    for (const r of missing.slice(0, 20)) {
      console.error(
        `  ${r.path} (${r.auth})${r.auth === 'admin' ? '' : '  ← reachable by any non-admin, for any device'}`,
      )
    }
    if (missing.length > 20) console.error(`  … and ${missing.length - 20} more`)
    console.error(
      `\n${unguarded.length} of them are not admin-gated either, which means no containment at all.` +
        '\nRun `npm run codegen`. If they are still missing, the access-map generator and the router generator' +
        "\ndisagree about a cap's effective surface — both must read `expandCapMethods`.",
    )
    process.exit(1)
  }

  console.log(
    `✓ method access map covers all ${routes.length} cap routes — the scope gate runs for every one`,
  )

  await checkInjectedSelectors()
}

void main()
