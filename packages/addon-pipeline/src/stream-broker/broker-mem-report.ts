import { readFile } from 'node:fs/promises'
import type { IScopedLogger } from '@camstack/types'
import {
  BROKER_MEM_INTERVAL_MS,
  consumerChurn,
  countActiveResources,
  formatBrokerMem,
  parseProcMaps,
  parseProcStatus,
  type ProcMapsSummary,
  type ProcStatusMem,
  readCopyOwnedTotals,
  readV8Heap,
  type SlabReading,
} from './stream-broker/broker-mem-probe.js'
import { readSlabTotals } from './stream-broker/slab-pool.js'
import { readDemuxWorkerHeaps } from './recorded/demux-off-thread.js'
import type { SessionMemReading } from './stream-broker/session-mem.js'
import type { StreamBrokerManager } from './stream-broker/stream-broker-manager.js'

interface BrokerMemReportDeps {
  readonly logger: IScopedLogger
  readonly manager: StreamBrokerManager
  readonly webrtcSessions: () => number
  /** Per-session backing-store readings; iterated here, at probe time only. */
  readonly sessionMem: () => readonly SessionMemReading[]
}

interface ProcReadings {
  readonly status: ProcStatusMem | null
  readonly maps: ProcMapsSummary | null
}

function readSlabReading(): SlabReading {
  const totals = readSlabTotals()
  const allocsDelta = totals.allocs - lastSlabAllocs
  lastSlabAllocs = totals.allocs
  return { live: totals.live, free: totals.free, allocsDelta }
}

/** Linux only: elsewhere (or on a read error) the native view is simply absent. */
async function readProc(): Promise<ProcReadings> {
  if (process.platform !== 'linux') return { status: null, maps: null }
  const [status, maps] = await Promise.all([
    readFile('/proc/self/status', 'utf8').then(parseProcStatus, () => null),
    readFile('/proc/self/maps', 'utf8').then(parseProcMaps, () => null),
  ])
  return { status, maps }
}

/** `slabAllocs` is a delta: the totals the previous line saw. */
let lastSlabAllocs = readSlabTotals().allocs

async function emitOnce(deps: BrokerMemReportDeps): Promise<void> {
  const now = Date.now()
  const [proc, worker] = await Promise.all([readProc(), readDemuxWorkerHeaps(now)])
  const resources = process.getActiveResourcesInfo()
  const line = formatBrokerMem({
    samples: deps.manager.getBrokerInstances().map((b) => b.getMemSample(now)),
    webrtcSessions: deps.webrtcSessions(),
    egressTranscodes: deps.manager.getEgressTranscodeCount(),
    childProcesses: countActiveResources(resources, 'ProcessWrap'),
    proc,
    churn: consumerChurn.drain(),
    copied: readCopyOwnedTotals(),
    slabs: readSlabReading(),
    v8: readV8Heap(),
    worker,
    sessions: deps.sessionMem(),
    arrayBuffersBytes: process.memoryUsage().arrayBuffers,
  })
  deps.logger.info(line)
}

/** Start the five-minute `[broker-mem]` heartbeat; returns its stop function. */
export function startBrokerMemReport(deps: BrokerMemReportDeps): () => void {
  const timer = setInterval(() => {
    emitOnce(deps).catch((err: unknown) => {
      deps.logger.warn('broker-mem probe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }, BROKER_MEM_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
