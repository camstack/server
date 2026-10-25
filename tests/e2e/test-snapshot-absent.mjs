#!/usr/bin/env node
/**
 * Verify that `snapshot.getSnapshot` on a camera without any native
 * snapshot provider + no active wrapper returns `null` gracefully instead
 * of 500 INTERNAL_SERVER_ERROR. Regression target: the logs the user hit
 * after creating a camera with no `snapshotUrl` — the native-cap bridge's
 * "no provider" error used to propagate up.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'

function log(...a) {
  console.log('[absent-e2e]', ...a)
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
  const ints = await trpc.integrations.list.query()
  const stale = ints.find((i) => i.addonId === 'provider-rtsp')
  if (stale) {
    const devs = await trpc.deviceManagement.list.query({})
    for (const d of devs.filter((d) => d.addonId === 'provider-rtsp')) {
      await trpc.deviceManagement.remove.mutate({ stableId: d.stableId })
    }
    await trpc.integrations.delete.mutate({ id: stale.id })
  }

  const integration = await trpc.integrations.create.mutate({
    addonId: 'provider-rtsp',
    name: 'Absent-native E2E',
  })
  integrationId = integration.id
  const created = await trpc.deviceManagement.createDevice.mutate({
    addonId: 'provider-rtsp',
    type: 'camera',
    config: { name: 'absent-native-test', mainStreamUrl: 'rtsp://fake/main' },
  })
  deviceId = created.stableId
  await new Promise((r) => setTimeout(r, 200))

  log(`getSnapshot on camera without snapshotUrl — expect null, not 500`)
  // Previously threw TRPCError INTERNAL_SERVER_ERROR; now should resolve null.
  const result = await trpc.snapshot.getSnapshot.query({ deviceId })
  ok(result === null, `expected null, got ${JSON.stringify(result)}`)
  log('  got null as expected')

  await trpc.deviceManagement.remove.mutate({ stableId: deviceId })
  deviceId = null
  await trpc.integrations.delete.mutate({ id: integrationId })
  integrationId = null

  log('✅ ABSENT-NATIVE SNAPSHOT E2E PASSED')
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
