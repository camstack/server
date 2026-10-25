#!/usr/bin/env node
/**
 * Exercise the WebRTC mDNS resolver path:
 *   1. createSession → grab the sessionId + server offer
 *   2. Build a minimal fake SDP answer that includes a `<uuid>.local`
 *      mDNS candidate — the kind Chrome emits by default
 *   3. Call handleAnswer with the fake answer
 *   4. Tail the server log for the mDNS resolve line
 *
 * The goal is NOT to establish a real peer connection (we don't feed RTP)
 * but to verify that:
 *   - The server logs `mDNS resolve <host> → <ip>` (or the failure line)
 *   - The setRemoteDescription call doesn't throw before the resolve
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { setGlobalDispatcher, Agent } from 'undici'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }))
const HOST = 'https://localhost:4443'
const wsUrl = HOST.replace('https:', 'wss:') + '/trpc'
const STABLE_ID = process.argv[2] ?? 'rtsp-1776343662504'
const LOG_PATH = '/Users/<local-user>/Documents/Git/camstack/camstack-server/server/backend/log.txt'

async function login() {
  const ws = createWSClient({ url: wsUrl, connectionParams: () => ({}) })
  const trpc = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })
  try {
    const r = await trpc.auth.login.mutate({ username: 'admin', password: 'admin' })
    return r.token
  } finally {
    ws.close()
  }
}

const token = await login()
const ws = createWSClient({ url: wsUrl, connectionParams: () => ({ token }) })
const trpc = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })

const streamId = `${STABLE_ID}/main`
const before = readFileSync(LOG_PATH, 'utf8').length

// 1. createSession
const { sessionId, sdpOffer } = await trpc.webrtc.createSession.mutate({ streamId })
console.log(
  `[probe] sessionId=${sessionId.slice(0, 8)}  offer candidates=${(sdpOffer.match(/a=candidate:/g) ?? []).length}`,
)

// 2. Extract server video/audio m-line info so the answer matches
//    (ufrag/pwd/fingerprint are arbitrary — werift will reject the
//    candidate but log the gathered set first, which is what we want).
const mLines = sdpOffer.split('\r\n').filter((l) => l.startsWith('m='))
console.log(`[probe] server offered m-lines:`, mLines)

// Build a minimal SDP answer with one mDNS-anonymised host candidate.
const mdnsHost = `${randomUUID()}.local`
const fakeAnswerSdp = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=ice-ufrag:AbCd',
  'a=ice-pwd:' + 'A'.repeat(22),
  'a=fingerprint:sha-256 FA:KE:FI:NG:ER:PR:IN:T:FO:R:TE:ST:IN:G:ON:LY:FA:KE:FI:NG:ER:PR:IN:T:FO:R:TE:ST:IN:G:OK:YY',
  'a=setup:active',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  `a=candidate:0 1 udp 2113937151 ${mdnsHost} 54321 typ host generation 0 network-cost 999`,
  'a=mid:0',
  'a=sendrecv',
  'a=rtpmap:96 H264/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 0',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=mid:1',
  'a=sendrecv',
  'a=rtpmap:0 PCMU/8000',
  '',
].join('\r\n')

console.log(`[probe] synthesised answer with mDNS host "${mdnsHost}"`)
console.log(`[probe] calling handleAnswer…`)
let answerError = null
try {
  await trpc.webrtc.handleAnswer.mutate({ sessionId, sdpAnswer: fakeAnswerSdp })
} catch (err) {
  answerError = err?.message ?? String(err)
}

// 3. Snapshot the new log lines (wait a beat for async resolver logging)
await new Promise((r) => setTimeout(r, 600))
const after = readFileSync(LOG_PATH, 'utf8')
const newLines = after.slice(before).split('\n')
const relevant = newLines.filter(
  (l) =>
    l.includes(sessionId.slice(0, 8)) ||
    l.includes('mDNS') ||
    l.includes(mdnsHost) ||
    l.includes('ICE state') ||
    l.includes('Answer received'),
)
console.log(`\n[probe] server log lines for this session:`)
for (const l of relevant) console.log('  ', l.replace(/^\[server\] /, ''))

if (answerError) {
  console.log(`\n[probe] handleAnswer threw: ${answerError}`)
}

const mdnsResolved = relevant.some((l) => l.includes('mDNS resolve') && l.includes(mdnsHost))
const mdnsFailed = relevant.some((l) => l.includes('mDNS resolve failed') && l.includes(mdnsHost))
console.log(`\n══════════════════════════════════════════════════════════════════════`)
if (mdnsResolved) {
  console.log(`  ✓ mDNS resolver path exercised: ${mdnsHost} was resolved to an IP`)
} else if (mdnsFailed) {
  console.log(`  ✓ mDNS resolver path exercised: ${mdnsHost} failed to resolve`)
  console.log(`    (expected — random UUID won't be on the LAN, but the resolver RAN)`)
} else {
  console.log(`  ✗ mDNS resolver did NOT log anything for ${mdnsHost}`)
  console.log(`    The rewrite path may not have been reached. Review the log lines above.`)
}
console.log(`══════════════════════════════════════════════════════════════════════`)

try {
  await trpc.webrtc.closeSession.mutate({ sessionId })
} catch {}
ws.close()
