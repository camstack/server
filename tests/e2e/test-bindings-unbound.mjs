#!/usr/bin/env node
/**
 * Verify that a camera WITHOUT `snapshotUrl` still shows snapshot as a
 * bindable cap (unbound + wrapper available) in the Bindings tab — and
 * activating the wrapper routes the cap through the SnapshotAddon.
 *
 * The previous BindingsTab only listed caps with a native binding; this
 * test exercises the listBindableCapsForDeviceType + union path.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'

function log(...a) {
  console.log('[unbound-e2e]', ...a)
}
function eq(a, b, m) {
  if (a !== b)
    throw new Error(`FAIL: ${m} — expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`)
}
function ok(c, m) {
  if (!c) throw new Error(`FAIL: ${m}`)
}

const boot = createWSClient({ url: wsUrl, connectionParams: () => ({}) })
const bootTrpc = createTRPCClient({ links: [wsLink({ client: boot, transformer: superjson })] })
const { token } = await bootTrpc.auth.login.mutate({ username: 'admin', password: 'admin' })
boot.close()
const ws = createWSClient({ url: wsUrl, connectionParams: () => ({ token }) })
const trpc = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })

let integrationId = null,
  deviceId = null
try {
  // Cleanup
  const ints = await trpc.integrations.list.query()
  const stale = ints.find((i) => i.addonId === 'provider-rtsp')
  if (stale) {
    const devs = await trpc.deviceManagement.list.query({})
    for (const d of devs.filter((d) => d.addonId === 'provider-rtsp')) {
      await trpc.deviceManagement.remove.mutate({ stableId: d.stableId })
    }
    await trpc.integrations.delete.mutate({ id: stale.id })
  }

  log('create integration + device WITHOUT snapshotUrl')
  const integration = await trpc.integrations.create.mutate({
    addonId: 'provider-rtsp',
    name: 'Unbound E2E',
  })
  integrationId = integration.id
  const created = await trpc.deviceManagement.createDevice.mutate({
    addonId: 'provider-rtsp',
    type: 'camera',
    config: {
      name: 'unbound-test',
      mainStreamUrl: 'rtsp://fake/main',
    },
  })
  deviceId = created.stableId
  await new Promise((r) => setTimeout(r, 400))

  log('listBindableCapsForDeviceType(camera)')
  const bindable = await trpc.deviceManager.listBindableCapsForDeviceType.query({
    deviceType: 'camera',
  })
  const capNames = bindable.map((c) => c.capName).sort()
  log(`  caps: ${capNames.join(', ')}`)
  ok(capNames.includes('snapshot'), 'snapshot cap is bindable for camera type')

  const snap = bindable.find((c) => c.capName === 'snapshot')
  ok(snap.wrappers.includes('snapshot'), "snapshot cap has 'snapshot' addon as wrapper")

  log('getBindings (without snapshotUrl → no snapshot native)')
  const bindings = await trpc.deviceManager.getBindings.query({ deviceId })
  const hasSnapshotBinding = bindings.entries.some((e) => e.capName === 'snapshot')
  eq(hasSnapshotBinding, false, 'snapshot NOT pre-bound (no snapshotUrl)')
  const hasDeviceOps = bindings.entries.some((e) => e.capName === 'device-ops')
  ok(hasDeviceOps, 'device-ops always bound')

  log('activate snapshot wrapper')
  await trpc.deviceManager.setWrapperActive.mutate({
    deviceId,
    capName: 'snapshot',
    wrapperAddonId: 'snapshot',
    active: true,
  })
  await new Promise((r) => setTimeout(r, 200))
  const after = await trpc.deviceManager.getBindings.query({ deviceId })
  const snapAfter = after.entries.find((e) => e.capName === 'snapshot')
  ok(snapAfter !== undefined, 'snapshot now bound after wrapper activation')
  eq(snapAfter.kind, 'wrapped', "kind is 'wrapped'")
  eq(snapAfter.providerAddonId, 'snapshot', 'provider is snapshot addon')

  log('deactivate + cleanup')
  await trpc.deviceManager.setWrapperActive.mutate({
    deviceId,
    capName: 'snapshot',
    wrapperAddonId: 'snapshot',
    active: false,
  })
  await trpc.deviceManagement.remove.mutate({ stableId: deviceId })
  deviceId = null
  await trpc.integrations.delete.mutate({ id: integrationId })
  integrationId = null

  log('✅ ALL UNBOUND-CAPS E2E PASSED')
  process.exit(0)
} catch (err) {
  log('❌', err.message)
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
