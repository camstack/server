#!/usr/bin/env node
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'

const boot = createWSClient({ url: wsUrl, connectionParams: () => ({}) })
const bootTrpc = createTRPCClient({ links: [wsLink({ client: boot, transformer: superjson })] })
const res = await bootTrpc.auth.login.mutate({ username: 'admin', password: 'admin' })
boot.close()

const ws = createWSClient({ url: wsUrl, connectionParams: () => ({ token: res.token }) })
const trpc = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })

for (const cap of ['snapshot', 'stream-broker', 'events', 'ptz']) {
  const wrappers = await trpc.deviceManager.listWrappersForCap.query({ capName: cap })
  console.log(`  ${cap}: [${wrappers.join(', ') || '(none)'}]`)
}

ws.close()
