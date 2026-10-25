#!/usr/bin/env node
/**
 * Probe: subscribe to systemEvents for a device and dump raw payloads
 * to understand the actual event structure.
 *
 * Usage: node tests/e2e/probe-device-events.mjs [deviceId]
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import ws from 'ws'
import superjson from 'superjson'

const DEVICE_ID = process.argv[2] || 'rtsp-1776343662504'
const WS_URL = 'wss://localhost:4443/trpc'

// Login to get JWT
async function getToken() {
  const res = await fetch('https://localhost:4443/trpc/auth.login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { username: 'admin', password: 'admin' } }),
  })
  const d = await res.json()
  return d?.result?.data?.json?.token
}
const jwt = await getToken()
if (!jwt) {
  console.error('Failed to get JWT')
  process.exit(1)
}

const wsClient = createWSClient({
  url: WS_URL,
  WebSocket: ws,
  connectionParams: () => ({ token: `Bearer ${jwt}` }),
})

const client = createTRPCClient({
  links: [wsLink({ client: wsClient, transformer: superjson })],
})

console.log(`Subscribing to events for device: ${DEVICE_ID}`)
console.log('Waiting for events... (Ctrl+C to stop)\n')

// Also fetch recent events
try {
  const recent = await client.systemEvents.getRecent.query({
    source: { type: 'device', id: DEVICE_ID },
    limit: 20,
  })
  console.log(`=== ${recent.length} recent events ===`)
  for (const ev of recent) {
    const cat = ev.category
    const dataKeys = Object.keys(ev.data || {})
    console.log(`  [${cat}] keys: ${JSON.stringify(dataKeys)}`)
    if (cat.includes('detection') || cat.includes('audio') || cat.includes('phase')) {
      console.log(`    payload: ${JSON.stringify(ev.data, null, 2).slice(0, 500)}`)
    }
  }
  console.log('')
} catch (err) {
  console.error('Failed to fetch recent events:', err.message)
}

// Subscribe live
const sub = client.systemEvents.subscribe.subscribe(
  { source: { type: 'device', id: DEVICE_ID } },
  {
    onData: (event) => {
      const cat = event.category
      const data = event.data || {}
      const dataKeys = Object.keys(data)

      // Skip motion analysis noise
      if (cat === 'detection.motion-analysis' || cat === 'detection.motion-zones-raw') return

      const ts = new Date(event.timestamp).toLocaleTimeString()
      console.log(`[${ts}] ${cat}`)
      console.log(`  source: ${JSON.stringify(event.source)}`)
      console.log(`  data keys: ${JSON.stringify(dataKeys)}`)
      console.log(`  payload: ${JSON.stringify(data, null, 2).slice(0, 800)}`)
      console.log('')
    },
    onError: (err) => console.error('Subscription error:', err),
  },
)

process.on('SIGINT', () => {
  sub.unsubscribe()
  wsClient.close()
  process.exit(0)
})
