#!/usr/bin/env tsx
/**
 * Smoke test for the unified `System` class.
 *
 * Walks through the public API surface against a live local server:
 *   1. Construct + login
 *   2. init() warm-boot
 *   3. listDevices() / getDevice() — exercise mirror + binding propagation
 *   4. system.<systemCap>.<method>() — call a known cluster-wide cap
 *   5. close()
 *
 * Configure via env:
 *   - SMOKE_URL  (default: https://localhost:4443)
 *   - SMOKE_USER (default: admin)
 *   - SMOKE_PASS (default: admin)
 *
 * Run: npx tsx scripts/smoke-system.ts
 *
 * Treats every step as a hard assertion — non-zero exit on failure.
 *
 * Note: this script TLS-trusts the local self-signed cert by setting
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for the duration of the run. Do not
 * import this script from production code.
 */

import { System } from '../packages/sdk/dist/index.js'
import { createDeviceProxy } from '../packages/types/dist/index.js'

// Local dev server uses a self-signed cert — disable TLS verification
// for the duration of the smoke run. Only valid for localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const SERVER_URL = process.env.SMOKE_URL ?? 'https://localhost:4443'
const USERNAME = process.env.SMOKE_USER ?? 'admin'
const PASSWORD = process.env.SMOKE_PASS ?? 'admin'

const log = (msg: string): void => {
  console.log(`[smoke-system] ${msg}`)
}

const fail = (msg: string): never => {
  console.error(`[smoke-system] FAIL: ${msg}`)
  process.exit(1)
}

async function main(): Promise<void> {
  log(`server: ${SERVER_URL}`)

  // The SDK auto-detects browser vs node — force HTTP mode so the
  // smoke test runs against a node process without a `window` global.
  // (The SDK still chooses HTTP under node by default; explicit here
  // for documentation.)
  const system = new System({
    serverUrl: SERVER_URL,
    useWebSocket: false,
  })

  // 1) Login
  log('auth.login …')
  const loginResult = await system.login(USERNAME, PASSWORD)
  if (typeof loginResult.token !== 'string' || loginResult.token.length === 0) {
    fail(`login returned no token (${JSON.stringify(loginResult)})`)
  }
  log(`auth.login OK (token prefix=${loginResult.token.slice(0, 12)}…)`)

  // 2) getMe
  const me = await system.getMe()
  log(`auth.me OK (username=${me.username}, role=${me.role})`)

  // 3) init() — warm-boot mirror
  log('init() …')
  const t0 = Date.now()
  await system.init()
  log(`init OK in ${Date.now() - t0}ms (ready=${system.isReady()})`)

  // 4) listDevices() — sync from mirror
  const devices = system.listDevices()
  log(`listDevices() → ${devices.length} devices`)

  if (devices.length > 0) {
    const first = devices[0]!
    const proxy = system.getDevice(first.deviceId)
    if (!proxy) fail(`getDevice(${first.deviceId}) returned null`)
    if (proxy.deviceId !== first.deviceId) {
      fail(`getDevice(${first.deviceId}).deviceId mismatch`)
    }
    // Phase 5: binding field is populated from the mirror cache.
    if (proxy.binding === null) {
      fail(`getDevice(${first.deviceId}).binding is null — expected populated entry`)
    }
    if (proxy.binding!.deviceId !== first.deviceId) {
      fail(`binding.deviceId (${proxy.binding!.deviceId}) ≠ proxy.deviceId (${first.deviceId})`)
    }
    log(`getDevice OK — binding has ${proxy.binding!.entries.length} entries`)
  } else {
    log('  (no devices in mirror — falling back to direct createDeviceProxy check)')
  }

  // Phase 5: even when the mirror is empty (server bindings not yet
  // populated, fresh restart), createDeviceProxy itself wires the
  // binding through. Verify with a synthetic binding so the check
  // never silently skips when the dev server is unconfigured.
  const syntheticBinding = { deviceId: 9999, entries: [] }
  const syntheticProxy = createDeviceProxy(system.trpcClient as never, syntheticBinding)
  if (syntheticProxy.deviceId !== 9999) {
    fail(`createDeviceProxy.deviceId ≠ 9999 (got ${syntheticProxy.deviceId})`)
  }
  if (syntheticProxy.binding !== syntheticBinding) {
    fail('createDeviceProxy did not propagate binding (expected reference equality)')
  }
  log('createDeviceProxy OK — binding field propagated by reference')

  // 5) System cap call — userManagement.listUsers (cluster-wide,
  //    deviceId-free, schema z.void()).
  log('system.userManagement.listUsers() …')
  const users = await system.userManagement.listUsers()
  log(`  → ${users.length} users`)

  // 6) Close
  log('close() …')
  system.close()
  log('close OK')

  log('PASS — every step succeeded')
}

main().catch((err: unknown) => {
  console.error('[smoke-system] crashed:', err)
  process.exit(1)
})
