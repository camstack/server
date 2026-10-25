#!/usr/bin/env node
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'
const STABLE_ID = 'rtsp-1776343662504'

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

async function run(label, fn) {
  try {
    const r = await fn()
    console.log(`[probe] ${label}:`, JSON.stringify(r))
  } catch (err) {
    console.log(`[probe] ${label}: ERROR ${err?.message ?? err}`)
  }
}

try {
  await run('deviceManagement.getStreamSources', () =>
    trpc.deviceManagement.getStreamSources.query({ stableId: STABLE_ID }),
  )
  await run('deviceManager.getBindings', () =>
    trpc.deviceManager.getBindings.query({ deviceId: STABLE_ID }),
  )
  await run('streamBroker.listBrokers', () => trpc.streamBroker.listBrokers.query({}))
  await run('streamBroker.getAllRtspEntries', () => trpc.streamBroker.getAllRtspEntries.query({}))
} finally {
  ws.close()
}
