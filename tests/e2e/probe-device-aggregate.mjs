#!/usr/bin/env node
/**
 * Diagnostic: dump the full payload the UI Config tab receives for a
 * device. Prints every section, its declared tab, every field id + type
 * + value, so we can identify:
 *
 *  - Which contributions are present / missing
 *  - Which fields render empty because values are not hydrated
 *  - Whether sections declare a `tab` id (for tabbed UI)
 *  - How long the URLs are (single-line rendering issue)
 *
 * Uses the same tRPC calls DeviceAggregateSection fires:
 *   deviceManager.getDeviceSettingsAggregate({ deviceId })
 *   deviceManager.getDeviceLiveInfoAggregate({ deviceId })
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'
const STABLE_ID = process.argv[2] ?? 'rtsp-1776343662504'

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

function fieldSummary(f) {
  const value = f?.value
  const hasValue = value !== undefined && value !== null && value !== ''
  const valueStr = hasValue
    ? typeof value === 'string'
      ? `"${value.length > 60 ? value.slice(0, 57) + '...' : value}" (len=${value.length})`
      : JSON.stringify(value).slice(0, 70)
    : '(empty)'
  const writer = f?._writerCapName ?? f?.writerCapName ?? '?'
  return `    - ${f.key ?? '?'} [${f.type ?? '?'}] writer=${writer} → ${valueStr}`
}

function dumpSchema(label, schema) {
  console.log(`\n=== ${label} ===`)
  if (!schema) {
    console.log('  null')
    return
  }
  const tabs = schema.tabs ?? []
  if (tabs.length > 0) {
    console.log(`  tabs declared: ${tabs.map((t) => `${t.id}:"${t.label}"`).join(', ')}`)
  } else {
    console.log(`  tabs: (none declared)`)
  }
  const sections = schema.sections ?? []
  console.log(`  sections: ${sections.length}`)
  for (const s of sections) {
    const tabLabel = s.tab ? `[tab=${s.tab}]` : '[NO TAB]'
    const writer = s._writerCapName ?? s.writerCapName ?? '?'
    console.log(
      `  ▸ ${s.id} "${s.title}" ${tabLabel} writer=${writer} fields=${s.fields?.length ?? 0}`,
    )
    for (const f of s.fields ?? []) {
      console.log(fieldSummary(f))
    }
  }
}

try {
  console.log(`[probe] device = ${STABLE_ID}`)

  const settings = await trpc.deviceManager.getDeviceSettingsAggregate.query({
    deviceId: STABLE_ID,
  })
  dumpSchema('SETTINGS aggregate (getDeviceSettingsAggregate)', settings)

  const live = await trpc.deviceManager.getDeviceLiveInfoAggregate.query({ deviceId: STABLE_ID })
  dumpSchema('LIVE aggregate (getDeviceLiveInfoAggregate)', live)

  console.log('\n[probe] done')
} finally {
  ws.close()
}
