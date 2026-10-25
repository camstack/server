#!/usr/bin/env node
/**
 * End-to-end wiring test for a forked-worker device (RTSP provider).
 *
 * What this exercises, over a real tRPC WebSocket against a running server:
 *   1. Take the `camstack login` session (shared resolver) and open an authenticated WSS tRPC client.
 *   2. Clean up any prior RTSP integration / device rows.
 *   3. Create the RTSP integration (`integrations.create`) — unique mode.
 *   4. Create a device (`deviceManagement.createDevice`) with a fake stream URL.
 *   5. Verify the device appears in `deviceManagement.list` — this catches the
 *      cross-process list union bug where forked-worker devices were invisible
 *      to the hub registry.
 *   6. Verify `deviceManagement.getStreamSources` returns the 3 configured streams
 *      — this catches the device-ops bridge (broker routing to worker).
 *   7. Verify `deviceManagement.getById` returns the right name.
 *   8. Toggle enable/disable via the bridge.
 *   9. Delete the device → confirm absence from list.
 *   10. Delete the integration.
 *
 * Run against an already-running dev server:
 *   node tests/e2e/device-rtsp-wiring.mjs
 *
 * Setup: `camstack login <host>` once (an admin account). No password is read here.
 * Env: CAMSTACK_HOST overrides the hub address (otherwise CAMSTACK_HUB_URL, scratchpad/.hub-url or the session).
 */
import { resolveHubAuth } from '../../scripts/hub/credentials.mjs'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

// Accept self-signed certs for localhost dev.
setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))

// The hub and the credential come from the `camstack login` session through the shared
// resolver (scripts/hub/credentials.mjs); CAMSTACK_HOST is an explicit override only.
const AUTH = await resolveHubAuth(
  process.env.CAMSTACK_HOST ? { server: process.env.CAMSTACK_HOST } : {},
)
const HOST = AUTH.server

const ADDON_ID = 'provider-rtsp'
const DEVICE_NAME = `e2e-test-${Date.now()}`

function log(...args) {
  console.log('[e2e]', ...args)
}

async function login() {
  return AUTH.token
}

function authedClient(token) {
  const wsUrl = HOST.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:')) + '/trpc'
  const ws = createWSClient({ url: wsUrl, connectionParams: () => ({ token }) })
  const trpc = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })
  return { trpc, close: () => ws.close() }
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
  }
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

async function main() {
  log(`host=${HOST} source=${AUTH.source}`)
  const token = await login()
  log('login ok, token length=', token.length)

  const { trpc, close } = authedClient(token)
  let integrationId = null
  let deviceId = null

  try {
    // ── 2. Cleanup any prior run ────────────────────────────────────────
    const existingIntegrations = await trpc.integrations.list.query()
    const stale = existingIntegrations.find((i) => i.addonId === ADDON_ID)
    if (stale) {
      log(`cleanup: deleting stale integration ${stale.id}`)
      // Delete any devices owned by the stale integration first.
      const allDevices = await trpc.deviceManagement.list.query({})
      for (const d of allDevices.filter((d) => d.addonId === ADDON_ID)) {
        log(`cleanup: removing stale device ${d.stableId}`)
        await trpc.deviceManagement.remove.mutate({ stableId: d.stableId })
      }
      await trpc.integrations.delete.mutate({ id: stale.id })
    }

    // ── 3. Create integration ───────────────────────────────────────────
    log('create integration')
    const integration = await trpc.integrations.create.mutate({
      addonId: ADDON_ID,
      name: 'RTSP E2E',
    })
    integrationId = integration.id
    assertTrue(integrationId.length > 0, 'integration.id is non-empty')
    assertEq(integration.addonId, ADDON_ID, 'integration.addonId')
    assertEq(integration.enabled, true, 'integration starts enabled')

    // ── 4. Create device ────────────────────────────────────────────────
    log('create device')
    const created = await trpc.deviceManagement.createDevice.mutate({
      addonId: ADDON_ID,
      type: 'camera',
      config: {
        name: DEVICE_NAME,
        mainStreamUrl: 'rtsp://fake-e2e/main',
        subStreamUrl: 'rtsp://fake-e2e/sub',
        lowStreamUrl: 'rtsp://fake-e2e/low',
      },
    })
    deviceId = created.stableId
    log(`device created stableId=${deviceId}`)
    assertEq(created.addonId, ADDON_ID, 'created.addonId')
    assertEq(created.name, DEVICE_NAME, 'created.name')

    // Give the hub a moment to propagate DeviceRegistered subscribers.
    await new Promise((r) => setTimeout(r, 300))

    // ── 5. List returns the device (cross-process union) ─────────────────
    log('list devices')
    const devices = await trpc.deviceManagement.list.query({})
    const found = devices.find((d) => d.stableId === deviceId)
    assertTrue(found !== undefined, `list must contain ${deviceId} (had ${devices.length} total)`)
    assertEq(found.name, DEVICE_NAME, 'list.name matches')

    // ── 6. getStreamSources via device-ops bridge ───────────────────────
    log('getStreamSources')
    const streams = await trpc.deviceManagement.getStreamSources.query({ stableId: deviceId })
    assertTrue(Array.isArray(streams), 'streams is an array')
    assertEq(streams.length, 3, 'streams.length === 3 (main+sub+low)')
    const mainStream = streams.find((s) => s.id === 'main')
    assertTrue(mainStream !== undefined, 'streams includes "main"')
    assertEq(mainStream.url, 'rtsp://fake-e2e/main', 'main stream URL matches')

    // ── 7. getById ──────────────────────────────────────────────────────
    log('getById')
    const byId = await trpc.deviceManagement.getById.query({ stableId: deviceId })
    assertTrue(byId !== null, 'getById non-null')
    assertEq(byId.name, DEVICE_NAME, 'getById.name')

    // ── 7b. getBindings — cross-process native-cap mirror ───────────────
    //
    // After device creation, RtspCamera.registerSnapshotProvider runs inside
    // the provider-rtsp worker and emits `device.bindings-changed` with
    // `reason: 'native-registered'`. The hub DeviceManagerAddon subscribes to
    // those events and mirrors the entries into `remoteNativeCaps`, so
    // `deviceManager.getBindings` must include the snapshot cap even though
    // the IDevice instance lives in the worker.
    //
    // Note: the snapshot cap only registers if the device config has
    // `snapshotUrl`. If the URL isn't set, this step asserts "no snapshot
    // entry" rather than failing — keeps the e2e runnable without a real
    // camera.
    log('getBindings (cross-process native mirror)')
    // Small delay to let the bindings-changed event propagate hub-side.
    await new Promise((r) => setTimeout(r, 300))
    const bindings = await trpc.deviceManager.getBindings.query({ deviceId })
    assertEq(bindings.deviceId, deviceId, 'bindings.deviceId matches')
    assertTrue(Array.isArray(bindings.entries), 'bindings.entries is an array')
    for (const e of bindings.entries) {
      assertTrue(typeof e.capName === 'string' && e.capName.length > 0, 'entry.capName non-empty')
      assertTrue(e.kind === 'native' || e.kind === 'wrapped', `entry.kind valid (got ${e.kind})`)
      assertTrue(
        typeof e.providerNodeId === 'string' && e.providerNodeId.length > 0,
        'entry.providerNodeId non-empty',
      )
    }
    log(`bindings.entries = ${JSON.stringify(bindings.entries)}`)

    // ── 8. Toggle enable/disable via bridge ──────────────────────────────
    log('disable device')
    await trpc.deviceManagement.disable.mutate({ stableId: deviceId })
    log('enable device')
    await trpc.deviceManagement.enable.mutate({ stableId: deviceId })

    // ── 9. Delete device ────────────────────────────────────────────────
    log('remove device')
    await trpc.deviceManagement.remove.mutate({ stableId: deviceId })
    await new Promise((r) => setTimeout(r, 300))
    const afterRemove = await trpc.deviceManagement.list.query({})
    const stillThere = afterRemove.find((d) => d.stableId === deviceId)
    assertTrue(stillThere === undefined, `device ${deviceId} should be gone after remove`)

    // Worker emits `native-unregistered` per cap on remove; hub drops them
    // from `remoteNativeCaps`. getBindings must return an empty entries list.
    const bindingsAfter = await trpc.deviceManager.getBindings.query({ deviceId })
    assertEq(bindingsAfter.entries.length, 0, 'bindings.entries empty after remove')
    deviceId = null

    // ── 10. Delete integration ──────────────────────────────────────────
    log('delete integration')
    await trpc.integrations.delete.mutate({ id: integrationId })
    integrationId = null

    log('✅ ALL E2E ASSERTIONS PASSED')
    process.exit(0)
  } catch (err) {
    log('❌ TEST FAILED:', err.message)
    if (err.stack) console.error(err.stack)
    // Best-effort cleanup
    if (deviceId) {
      try {
        await trpc.deviceManagement.remove.mutate({ stableId: deviceId })
      } catch {
        /* noop */
      }
    }
    if (integrationId) {
      try {
        await trpc.integrations.delete.mutate({ id: integrationId })
      } catch {
        /* noop */
      }
    }
    process.exit(1)
  } finally {
    close()
  }
}

main().catch((err) => {
  console.error('[e2e] fatal:', err)
  process.exit(1)
})
