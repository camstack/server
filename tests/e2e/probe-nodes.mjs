#!/usr/bin/env node
/**
 * Diagnostic: dump `nodes.topology` — the single source of truth for
 * cluster nodes. Regression fence: hub.addons non-empty, forked
 * sub-nodes kept only under `processes[]`.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'

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

function summarizeTopology(rows) {
  return rows
    .map((r) => {
      const procNames = r.processes.map((p) => p.name).join(', ')
      const addons = r.addons
        .map((a) => `${a.id}[${(a.capabilities ?? []).join(',') || '-'}]`)
        .join(' ')
      return `${r.isHub ? '★' : ' '} ${r.id.padEnd(24)} isHub=${r.isHub} online=${r.isOnline}\n    addons: ${addons}\n    processes: ${procNames}`
    })
    .join('\n')
}

try {
  console.log('=== nodes.topology ===')
  const topology = await trpc.nodes.topology.query()
  console.log(summarizeTopology(topology))

  console.log('\n=== regression checks ===')
  const hub = topology.find((r) => r.isHub)
  if (!hub) {
    console.log('⚠️  no hub entry in topology')
    process.exit(1)
  }
  console.log(
    hub.addons.length === 0
      ? '⚠️  hub.addons is EMPTY — regression'
      : `✅ hub.addons populated (${hub.addons.length} addons)`,
  )
  const forkedInTop = topology.some((r) => r.id.includes('/'))
  console.log(
    forkedInTop
      ? '⚠️  topology leaks forked sub-node as top-level'
      : '✅ no forked sub-nodes at top level (they live under processes[])',
  )
} finally {
  ws.close()
}
