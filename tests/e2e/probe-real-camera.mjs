#!/usr/bin/env node
/**
 * Live-stack diagnostic against a real RTSP camera. Exercises the full
 * chain: device creation → stream-broker wiring → snapshot → webrtc →
 * motion (via pipeline-orchestrator). Prints what works and what doesn't
 * so we can iterate on the broken link.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'
const REAL_RTSP = 'rtsp://192.168.x.x:53976/6997cbc33b6bb70b'

function log(...a) {
  console.log('[probe]', ...a)
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

try {
  // ── 1. Find or create device ──────────────────────────────────────────────
  log('listing devices')
  const devices = await trpc.deviceManagement.list.query({})
  const rtspDevices = devices.filter((d) => d.addonId === 'provider-rtsp')
  log(`  rtsp devices: ${rtspDevices.length}`)
  for (const d of rtspDevices) log(`    - ${d.stableId} (${d.name})`)

  let device = rtspDevices[0]
  if (!device) {
    log('no rtsp device present — creating with real URL')
    // Need an integration first
    const ints = await trpc.integrations.list.query()
    let integration = ints.find((i) => i.addonId === 'provider-rtsp')
    if (!integration) {
      integration = await trpc.integrations.create.mutate({
        addonId: 'provider-rtsp',
        name: 'Live Probe',
      })
    }
    const created = await trpc.deviceManagement.createDevice.mutate({
      addonId: 'provider-rtsp',
      type: 'camera',
      config: {
        name: 'Live probe camera',
        mainStreamUrl: REAL_RTSP,
      },
    })
    device = { stableId: created.stableId, name: created.name, addonId: 'provider-rtsp' }
    log(`  created: ${device.stableId}`)
    await new Promise((r) => setTimeout(r, 800))
  }

  const deviceId = device.stableId
  log(`== probing deviceId=${deviceId} ==`)

  // ── 2. Stream-broker state ────────────────────────────────────────────────
  log('stream-broker listBrokers')
  const brokers = await trpc.streamBroker.listBrokers.query()
  const forDevice = brokers.filter((b) => b.brokerId.startsWith(deviceId))
  log(`  brokers total=${brokers.length}, for this device=${forDevice.length}`)
  for (const b of forDevice) log(`    - ${b.brokerId} status=${b.status}`)

  log('stream-broker getAllRtspEntries')
  const rtsp = await trpc.streamBroker.getAllRtspEntries.query({})
  const rtspForDev = rtsp.filter((e) => e.brokerId.startsWith(deviceId))
  log(`  rtsp entries total=${rtsp.length}, for this device=${rtspForDev.length}`)
  for (const e of rtspForDev) log(`    - ${e.brokerId} enabled=${e.enabled} url=${e.url}`)

  // ── 3. Bindings ───────────────────────────────────────────────────────────
  log('deviceManager.getBindings')
  const bindings = await trpc.deviceManager.getBindings.query({ deviceId })
  log(`  entries: ${JSON.stringify(bindings.entries)}`)

  // ── 4. Snapshot ───────────────────────────────────────────────────────────
  log('snapshot.getSnapshot')
  try {
    const snap = await trpc.snapshot.getSnapshot.query({ deviceId })
    log(
      `  result: ${snap ? `JPEG ${Math.round((snap.base64.length * 0.75) / 1024)} KB (${snap.contentType})` : 'null'}`,
    )
  } catch (err) {
    log(`  ❌ ERROR: ${err.message ?? err}`)
  }

  // ── 5. WebRTC ─────────────────────────────────────────────────────────────
  log('webrtc.createSession (main stream)')
  try {
    const sess = await trpc.webrtc.createSession.mutate({ streamId: `${deviceId}/main` })
    log(`  sessionId=${sess.sessionId}, sdp len=${sess.sdpOffer.length}`)
    await trpc.webrtc.closeSession.mutate({ sessionId: sess.sessionId }).catch(() => {})
  } catch (err) {
    log(`  ❌ ERROR: ${err.message ?? err}`)
  }

  // ── 6. Pipeline assignment ────────────────────────────────────────────────
  log('pipelineOrchestrator.getPipelineAssignment')
  try {
    const asg = await trpc.pipelineOrchestrator.getPipelineAssignment.query({ deviceId })
    log(`  assignment: ${asg ? `nodeId=${asg.agentNodeId}` : 'none'}`)
  } catch (err) {
    log(`  ❌ ERROR: ${err.message ?? err}`)
  }

  log('done')
  process.exit(0)
} catch (err) {
  log('❌ FATAL:', err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
} finally {
  ws.close()
}
