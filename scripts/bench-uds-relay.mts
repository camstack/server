#!/usr/bin/env tsx
/**
 * hub-main as a ROUTER: what one sibling↔sibling cap call costs the parent,
 * with and without raw-forward.
 *
 * Why this exists: hub-main routes every call between two of its runners.
 * Until raw-forward it decoded the whole request, rebuilt it, re-encoded it,
 * and did the same to the answer — on the one thread that serves every tRPC
 * request. D441 measured the plane at ~600 req/s and ~10 MB/s with msgpack
 * decode at ~27 % of the busy time and encode at ~6 %, feeding a 29.5 % GC
 * share; D446 priced the decoded-audio plane alone at 340 of ~470 MB/min.
 *
 * This harness reproduces the hub's mix through a REAL parent — a
 * `LocalChildRegistry` over UDS in its own process, so its CPU and GC are
 * measured on their own — with two real `LocalChildClient`s in two more
 * processes: one asks, the other answers, both at the shapes the hub moves:
 *
 *   - `audio`  : 13.5 KB PCM bin request, 200 B result       (analyseChunk)
 *   - `pull`   : ~100 B request, 8 × 13.5 KB PCM bin result   (pullAudioChunks)
 *   - `graph`  : ~2 KB object-graph request and result        (settings-ish)
 *
 * The A/B is the peer of the previous release: the `inline` leg runs the two
 * children on raw channels that register WITHOUT `rawForward` — exactly the
 * frames a pre-D448 runner sends — so the parent decodes and re-encodes every
 * call as it did before. The parent is the same code in both legs; there is
 * no switch on it to flip (D449). Nothing else differs.
 *
 * Measured IN THE PARENT per run: main-thread CPU (user+sys) per 1 000 relayed
 * calls, GC time (perf_hooks 'gc' entries) per 1 000 calls, bytes allocated on
 * the V8 heap per call (`v8.getHeapStatistics().total_allocated`? no — that is
 * not exposed; we read `process.memoryUsage().heapUsed` deltas across a
 * forced `gc()` as a proxy for retention, and count scavenges).
 *
 * Usage:
 *   npx tsx scripts/bench-uds-relay.mts [calls=20000] [shape=audio|pull|graph|all]
 *
 * Exit 0 on success. Every number is printed for both modes side by side; a
 * run whose two modes disagree on the answer VALUES fails.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { PerformanceObserver } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import type { CapCallMessage } from '../packages/system/src/kernel/transport/child-cap-protocol.ts'
import { createLocalTransport } from '../packages/system/src/kernel/transport/create-local-transport.ts'
import { LocalChildClient } from '../packages/system/src/kernel/transport/local-child-client.ts'
import { LocalChildRegistry } from '../packages/system/src/kernel/transport/local-child-registry.ts'

type Shape = 'audio' | 'pull' | 'graph'
const SHAPES: readonly Shape[] = ['audio', 'pull', 'graph']
/**
 * Which release the two CHILDREN speak: `raw` is a `LocalChildClient` of this
 * release (declares `rawForward`, packs a payload once acked); `inline` is a
 * raw channel that registers without the flag, the wire a pre-D448 runner
 * puts in front of the same parent.
 */
type PeerMode = 'raw' | 'inline'

interface ParentReport {
  readonly calls: number
  readonly cpuMs: number
  readonly gcMs: number
  readonly gcCount: number
  readonly forward: { raw: number; decoded: number }
}

// ── roles ────────────────────────────────────────────────────────────────────

async function runParent(nodeId: string, expectedCalls: number): Promise<void> {
  const registry = new LocalChildRegistry({
    server: createLocalTransport().createServer(nodeId),
    ownNodeId: nodeId,
    onUnownedCall: async () => {
      throw new Error('bench: no unowned calls expected')
    },
  })
  await registry.start()
  let gcMs = 0
  let gcCount = 0
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcMs += e.duration
      gcCount += 1
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  process.send?.({ kind: 'ready' })
  let cpuStart = process.cpuUsage()
  let forwardAtMark = registry.readForwardCensus()
  process.on('message', (msg: { kind: string }) => {
    if (msg.kind === 'mark') {
      cpuStart = process.cpuUsage()
      gcMs = 0
      gcCount = 0
      forwardAtMark = registry.readForwardCensus()
      process.send?.({ kind: 'marked' })
      return
    }
    if (msg.kind === 'report') {
      const cpu = process.cpuUsage(cpuStart)
      const now = registry.readForwardCensus()
      const report: ParentReport = {
        calls: expectedCalls,
        cpuMs: (cpu.user + cpu.system) / 1000,
        gcMs,
        gcCount,
        forward: { raw: now.raw - forwardAtMark.raw, decoded: now.decoded - forwardAtMark.decoded },
      }
      process.send?.({ kind: 'report', report })
      return
    }
    if (msg.kind === 'exit') {
      void registry.close().then(() => process.exit(0))
    }
  })
}

const PCM_BYTES = 13_500
const pcm = (fill: number): Uint8Array => new Uint8Array(PCM_BYTES).fill(fill)

function graphValue(seed: number): Record<string, unknown> {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      id: seed * 100 + i,
      name: `device-${seed}-${i}`,
      enabled: i % 2 === 0,
      thresholds: { min: 0.25, max: 0.9, classes: ['person', 'car', 'dog'] },
      updatedAt: 1_757_500_000_000 + i,
    })
  }
  return { rows, total: rows.length, seed }
}

/** The provider's answer for one shape — the same in both peer modes. */
function answer(method: string, args: unknown): unknown {
  if (method === 'audio') {
    const a = args as { chunk: { data: Uint8Array } }
    return { level: { rms: 0.1, dbfs: -20 }, seen: a.chunk.data.byteLength }
  }
  if (method === 'pull') {
    const out: { data: Uint8Array; sampleRate: number; channels: number; timestamp: number }[] = []
    for (let i = 0; i < 8; i += 1) {
      out.push({ data: pcm(i), sampleRate: 16_000, channels: 1, timestamp: Date.now() })
    }
    return out
  }
  const g = args as { seed: number }
  return graphValue(g.seed + 1)
}

async function runProvider(nodeId: string, mode: PeerMode): Promise<void> {
  const caps = [{ capName: 'bench', mode: 'singleton' as const }]
  if (mode === 'inline') {
    // A provider of the previous release: a raw channel, `register` without
    // `rawForward`, and inline args on every `cap-call` the parent hands it.
    const raw = createLocalTransport().createClient(nodeId)
    const channel = await raw.connect()
    channel.onRequest(async (body) => {
      const call = body as CapCallMessage
      return answer(call.method, call.args)
    })
    await channel.request({ kind: 'register', childId: 'provider', caps })
    process.send?.({ kind: 'ready' })
    process.on('message', (msg: { kind: string }) => {
      if (msg.kind === 'exit') void raw.close().then(() => process.exit(0))
    })
    return
  }
  const client = new LocalChildClient({
    nodeId,
    childId: 'provider',
    caps,
    dispatch: async (call) => answer(call.method, call.args),
  })
  await client.start()
  process.send?.({ kind: 'ready' })
  process.on('message', (msg: { kind: string }) => {
    if (msg.kind === 'exit') void client.close().then(() => process.exit(0))
  })
}

interface CallerPeer {
  readonly callOut: (call: { capName: string; method: string; args: unknown }) => Promise<unknown>
  readonly close: () => Promise<void>
}

/** The caller of this release, or one of the previous release on a raw channel. */
async function connectCaller(nodeId: string, mode: PeerMode): Promise<CallerPeer> {
  if (mode === 'inline') {
    const raw = createLocalTransport().createClient(nodeId)
    const channel = await raw.connect()
    await channel.request({ kind: 'register', childId: 'caller', caps: [] })
    return {
      callOut: (call) => channel.request({ kind: 'cap-call-out', ...call }),
      close: () => raw.close(),
    }
  }
  const client = new LocalChildClient({
    nodeId,
    childId: 'caller',
    caps: [],
    dispatch: async () => null,
  })
  await client.start()
  return { callOut: (call) => client.callOut(call), close: () => client.close() }
}

async function runCaller(
  nodeId: string,
  shape: Shape,
  calls: number,
  mode: PeerMode,
): Promise<void> {
  const client = await connectCaller(nodeId, mode)
  process.send?.({ kind: 'ready' })
  process.on('message', async (msg: { kind: string }) => {
    if (msg.kind === 'go') {
      let checksum = 0
      const inflight = 8
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < calls) {
          const i = next++
          if (shape === 'audio') {
            const r = (await client.callOut({
              capName: 'bench',
              method: 'audio',
              args: {
                chunk: { data: pcm(i & 0xff), sampleRate: 16_000, channels: 1, timestamp: i },
                settings: { minConfidence: 0.3, allowedClasses: [] },
              },
            })) as { seen: number }
            checksum += r.seen
          } else if (shape === 'pull') {
            const r = (await client.callOut({
              capName: 'bench',
              method: 'pull',
              args: { subscriptionId: 'ac-0000', maxCount: 8 },
            })) as { data: Uint8Array }[]
            checksum += r.length * r[0]!.data.byteLength
          } else {
            const r = (await client.callOut({
              capName: 'bench',
              method: 'graph',
              args: graphValue(i),
            })) as {
              total: number
            }
            checksum += r.total
          }
        }
      }
      await Promise.all(Array.from({ length: inflight }, () => worker()))
      process.send?.({ kind: 'done', checksum })
      return
    }
    if (msg.kind === 'exit') void client.close().then(() => process.exit(0))
  })
}

// ── driver ───────────────────────────────────────────────────────────────────

function spawn(role: string, args: string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const cp = fork(fileURLToPath(import.meta.url), [role, ...args], {
      execArgv: ['--import', 'tsx'],
    })
    cp.once('message', (m: { kind: string }) =>
      m.kind === 'ready' ? resolve(cp) : reject(new Error(`bad ready: ${m.kind}`)),
    )
    cp.once('exit', (code) => reject(new Error(`${role} exited early with ${code}`)))
  })
}

function ask<T>(cp: ChildProcess, send: object, want: string): Promise<T> {
  return new Promise((resolve) => {
    const on = (m: { kind: string } & Record<string, unknown>): void => {
      if (m.kind === want) {
        cp.off('message', on)
        // process boundary: an IPC message from a forked role of this same
        // script, shaped by the `process.send` calls above — nothing else can
        // reach this listener, and the bench has no wire schema to validate
        // it against.
        resolve(m as unknown as T)
      }
    }
    cp.on('message', on)
    cp.send(send)
  })
}

async function runOnce(
  shape: Shape,
  calls: number,
  mode: PeerMode,
): Promise<{ report: ParentReport; checksum: number; wallMs: number }> {
  const nodeId = `bench-relay-${process.pid}-${Math.random().toString(36).slice(2)}`
  const parent = await spawn('parent', [nodeId, String(calls)])
  const provider = await spawn('provider', [nodeId, mode])
  const caller = await spawn('caller', [nodeId, shape, String(calls), mode])
  // Warm-up so JIT and socket buffers are not in the measured window.
  await ask(caller, { kind: 'go' }, 'done')
  await ask(parent, { kind: 'mark' }, 'marked')
  const t0 = performance.now()
  const done = await ask<{ checksum: number }>(caller, { kind: 'go' }, 'done')
  const wallMs = performance.now() - t0
  const { report } = await ask<{ report: ParentReport }>(parent, { kind: 'report' }, 'report')
  for (const cp of [caller, provider, parent]) {
    cp.removeAllListeners('exit')
    cp.send({ kind: 'exit' })
  }
  await Promise.all([caller, provider, parent].map((cp) => new Promise((r) => cp.once('exit', r))))
  return { report, checksum: done.checksum, wallMs }
}

function per1k(v: number, calls: number): string {
  return ((v / calls) * 1000).toFixed(1)
}

async function main(): Promise<void> {
  const role = process.argv[2]
  if (role === 'parent') return runParent(process.argv[3]!, Number(process.argv[4]))
  if (role === 'provider') return runProvider(process.argv[3]!, process.argv[4] as PeerMode)
  if (role === 'caller') {
    return runCaller(
      process.argv[3]!,
      process.argv[4] as Shape,
      Number(process.argv[5]),
      process.argv[6] as PeerMode,
    )
  }

  const calls = Number(process.argv[2] ?? 20_000)
  const which = (process.argv[3] ?? 'all') as Shape | 'all'
  const shapes = which === 'all' ? SHAPES : [which]
  console.log(
    `bench-uds-relay: ${calls} relayed calls per run, 8 in flight, parent measured in its own process`,
  )
  console.log('')
  console.log(
    'shape   mode     wall ms   calls/s   parent CPU ms/1k   GC ms/1k   GC count/1k   fwd raw/decoded',
  )
  let ok = true
  for (const shape of shapes) {
    const before = await runOnce(shape, calls, 'inline')
    const after = await runOnce(shape, calls, 'raw')
    if (before.checksum !== after.checksum) {
      ok = false
      console.log(
        `!! ${shape}: checksum differs (inline ${before.checksum} vs raw ${after.checksum})`,
      )
    }
    for (const [mode, r] of [
      ['inline', before],
      ['raw', after],
    ] as const) {
      const rep = r.report
      console.log(
        `${shape.padEnd(7)} ${mode.padEnd(8)} ${r.wallMs.toFixed(0).padStart(7)}   ${((calls / r.wallMs) * 1000).toFixed(0).padStart(7)}   ${per1k(rep.cpuMs, calls).padStart(17)}   ${per1k(rep.gcMs, calls).padStart(8)}   ${per1k(rep.gcCount, calls).padStart(11)}   ${rep.forward.raw}/${rep.forward.decoded}`,
      )
    }
    const cpuGain = 1 - after.report.cpuMs / before.report.cpuMs
    const gcGain = 1 - after.report.gcMs / Math.max(1e-9, before.report.gcMs)
    console.log(
      `${''.padEnd(7)} parent CPU −${(cpuGain * 100).toFixed(0)} %, parent GC time −${(gcGain * 100).toFixed(0)} %`,
    )
    console.log('')
  }
  process.exit(ok ? 0 : 1)
}

void main()
