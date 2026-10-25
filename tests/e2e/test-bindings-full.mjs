#!/usr/bin/env node
/**
 * Full-stack verification of cross-process native-cap mirroring + wrapper
 * listing. Unlike `device-rtsp-wiring.mjs`, this creates an RTSP camera WITH
 * `snapshotUrl` so `RtspCamera.registerSnapshotProvider` fires inside the
 * provider-rtsp forked worker. Expected outcome:
 *
 *   getBindings({deviceId}).entries includes one entry:
 *     { capName: 'snapshot', kind: 'native',
 *       providerNodeId: 'hub/provider-rtsp' (or similar worker nodeID),
 *       providerAddonId: 'provider-rtsp',
 *       nativeAddonId: 'provider-rtsp' }
 *
 *   listWrappersForCap({capName: 'snapshot'}) includes 'snapshot' (the
 *   built-in snapshot addon registered as kind: 'wrapper').
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))

const HOST = 'https://localhost:4443'
const ADDON_ID = 'provider-rtsp'
const DEVICE_NAME = `e2e-bindings-${Date.now()}`
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'

function log(...args) {
  console.log('[bindings-e2e]', ...args)
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}
function assertEq(a, b, msg) {
  if (a !== b)
    throw new Error(`FAIL: ${msg} — expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`)
}

async function login() {
  const boot = createWSClient({ url: wsUrl, connectionParams: () => ({}) })
  const trpc = createTRPCClient({ links: [wsLink({ client: boot, transformer: superjson })] })
  try {
    const r = await trpc.auth.login.mutate({ username: 'admin', password: 'admin' })
    return r.token
  } finally {
    boot.close()
  }
}

const token = await login()
const ws = createWSClient({ url: wsUrl, connectionParams: () => ({ token }) })
const trpc = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })

let integrationId = null
let deviceId = null

try {
  // Cleanup prior runs
  const ints = await trpc.integrations.list.query()
  const stale = ints.find((i) => i.addonId === ADDON_ID)
  if (stale) {
    const devs = await trpc.deviceManagement.list.query({})
    for (const d of devs.filter((d) => d.addonId === ADDON_ID)) {
      await trpc.deviceManagement.remove.mutate({ stableId: d.stableId })
    }
    await trpc.integrations.delete.mutate({ id: stale.id })
  }

  log('create integration')
  const integration = await trpc.integrations.create.mutate({
    addonId: ADDON_ID,
    name: 'Bindings E2E',
  })
  integrationId = integration.id

  log('create device with snapshotUrl')
  const created = await trpc.deviceManagement.createDevice.mutate({
    addonId: ADDON_ID,
    type: 'camera',
    config: {
      name: DEVICE_NAME,
      mainStreamUrl: 'rtsp://fake-e2e/main',
      subStreamUrl: 'rtsp://fake-e2e/sub',
      lowStreamUrl: 'rtsp://fake-e2e/low',
      snapshotUrl: 'http://fake-e2e/snap.jpg',
    },
  })
  deviceId = created.stableId
  log(`device created stableId=${deviceId}`)

  // Wait for DeviceBindingsChanged broadcast to propagate hub-side
  await new Promise((r) => setTimeout(r, 500))

  log('getBindings expecting snapshot native from worker')
  const bindings = await trpc.deviceManager.getBindings.query({ deviceId })
  log(`  entries: ${JSON.stringify(bindings.entries)}`)
  assertTrue(bindings.entries.length >= 1, 'at least one binding entry')
  const snapshotEntry = bindings.entries.find((e) => e.capName === 'snapshot')
  assertTrue(snapshotEntry !== undefined, 'snapshot cap present')
  assertEq(snapshotEntry.nativeAddonId, 'provider-rtsp', 'native addon is provider-rtsp')
  assertTrue(snapshotEntry.providerNodeId.length > 0, 'providerNodeId non-empty')
  assertTrue(
    snapshotEntry.providerNodeId !== 'hub',
    `providerNodeId is a worker, got '${snapshotEntry.providerNodeId}'`,
  )

  log('listWrappersForCap(snapshot)')
  const wrappers = await trpc.deviceManager.listWrappersForCap.query({ capName: 'snapshot' })
  log(`  wrappers: ${JSON.stringify(wrappers)}`)
  assertTrue(wrappers.includes('snapshot'), "wrappers must include 'snapshot' addon")

  log('setWrapperActive(snapshot, snapshot, true)')
  await trpc.deviceManager.setWrapperActive.mutate({
    deviceId,
    capName: 'snapshot',
    wrapperAddonId: 'snapshot',
    active: true,
  })
  await new Promise((r) => setTimeout(r, 200))
  const afterActive = await trpc.deviceManager.getBindings.query({ deviceId })
  const afterEntry = afterActive.entries.find((e) => e.capName === 'snapshot')
  assertTrue(afterEntry !== undefined, 'snapshot still present after wrapper activation')
  assertEq(afterEntry.kind, 'wrapped', 'kind switched to wrapped')
  assertEq(afterEntry.providerAddonId, 'snapshot', 'providerAddonId is the wrapper')
  assertEq(afterEntry.nativeAddonId, 'provider-rtsp', 'nativeAddonId still points to the worker')

  log('setWrapperActive(snapshot, snapshot, false) — revert to native')
  await trpc.deviceManager.setWrapperActive.mutate({
    deviceId,
    capName: 'snapshot',
    wrapperAddonId: 'snapshot',
    active: false,
  })
  await new Promise((r) => setTimeout(r, 200))
  const afterRevert = await trpc.deviceManager.getBindings.query({ deviceId })
  const revertEntry = afterRevert.entries.find((e) => e.capName === 'snapshot')
  assertTrue(revertEntry !== undefined, 'snapshot still present after revert')
  assertEq(revertEntry.kind, 'native', 'kind reverted to native')
  assertEq(revertEntry.providerAddonId, 'provider-rtsp', 'providerAddonId back to worker')

  log('cleanup')
  await trpc.deviceManagement.remove.mutate({ stableId: deviceId })
  await new Promise((r) => setTimeout(r, 500))
  const afterRemove = await trpc.deviceManager.getBindings.query({ deviceId })
  log(`  afterRemove entries: ${JSON.stringify(afterRemove.entries)}`)
  assertEq(afterRemove.entries.length, 0, 'entries empty after device removal')
  deviceId = null
  await trpc.integrations.delete.mutate({ id: integrationId })
  integrationId = null

  log('✅ ALL BINDINGS E2E ASSERTIONS PASSED')
  process.exit(0)
} catch (err) {
  log('❌ FAILED:', err.message)
  if (err.stack) console.error(err.stack)
  if (deviceId) {
    try {
      await trpc.deviceManagement.remove.mutate({ stableId: deviceId })
    } catch {}
  }
  if (integrationId) {
    try {
      await trpc.integrations.delete.mutate({ id: integrationId })
    } catch {}
  }
  process.exit(1)
} finally {
  ws.close()
}
