/**
 * broker-mem-probe — what owns the broker runner's NATIVE memory.
 *
 * The runner's `[mem]` heartbeat (`kernel/heap-watch.ts`) says how big the
 * process is; it cannot say who holds it. On the hub, `stream-broker` grew
 * 250 -> 1015 MB in steps while `heapUsed` stayed at ~90 MB and `arrayBuffers`
 * at ~150 MB, so ~600 MB sat outside everything the heartbeat reports. This
 * module is the attribution half: one `[broker-mem]` line every five minutes
 * carrying the kernel's view of the process (RssAnon / RssFile, the `[heap]`
 * brk mapping, the count of anonymous mappings) NEXT TO the broker's own
 * structures (rings, write queues, consumers by kind, egress children), so a
 * step in RSS can be laid against what changed.
 *
 * It is a probe, not a fix: no caps, no allocator tuning, no snapshot. Cost is
 * O(brokers + sessions) per line and O(1) per packet (two integer adds in
 * `copyOwned`). Everything here is a pure function over plain data so the
 * aggregation and the `/proc` parsers are testable on fixture text.
 */

import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8'
import type { IScopedLogger } from '@camstack/types'
import { type SessionMemReading, sessionBackingBytes } from './session-mem.js'

const MB = 1024 * 1024

/** Cadence of the `[broker-mem]` line — aligned with the runner's `[mem]`. */
export const BROKER_MEM_INTERVAL_MS = 5 * 60_000

/** Per-camera ring breakdown kept on the line (top N by held bytes). */
export const BROKER_MEM_TOP_CAMERAS = 5

/** `copyOwned` totals since process start. */
export interface CopyOwnedTotals {
  readonly packets: number
  readonly bytes: number
}

let copiedPackets = 0
let copiedBytes = 0

/** O(1) per packet: called by `copyOwned`. No allocation. */
export function recordCopyOwned(bytes: number): void {
  copiedPackets += 1
  copiedBytes += bytes
}

export function readCopyOwnedTotals(): CopyOwnedTotals {
  return { packets: copiedPackets, bytes: copiedBytes }
}

// ---------------------------------------------------------------------------
// /proc parsers (Linux only; callers skip gracefully elsewhere)
// ---------------------------------------------------------------------------

export interface ProcStatusMem {
  readonly rssAnonKb: number
  readonly rssFileKb: number
}

/** `RssAnon:` / `RssFile:` out of `/proc/self/status` text; null when absent. */
export function parseProcStatus(text: string): ProcStatusMem | null {
  const anon = /^RssAnon:\s+(\d+)\s*kB/m.exec(text)
  const file = /^RssFile:\s+(\d+)\s*kB/m.exec(text)
  if (anon === null || file === null) return null
  return { rssAnonKb: Number(anon[1]), rssFileKb: Number(file[1]) }
}

export interface ProcMapsSummary {
  /** Virtual size of the `[heap]` (brk) mapping; 0 when there is none. */
  readonly heapBytes: number
  /** Mappings with no backing path (anonymous, `[heap]`/`[stack]` excluded). */
  readonly anonMappings: number
  /** Their summed virtual size. */
  readonly anonBytes: number
  /** Anonymous mappings of EXACTLY one V8 page (256 KB). */
  readonly v8PageMaps: number
}

/** One V8 page (`kPageSize`) — the size of every pooled/retained heap page. */
export const V8_PAGE_BYTES = 256 * 1024

/**
 * Summarise `/proc/self/maps`. Cheaper than `smaps_rollup`'s kernel page walk:
 * the file is one line per mapping and needs no per-page accounting. The
 * `[heap]` figure is the brk extent (virtual), which is the number glibc's
 * main arena grows when fragmented.
 *
 * Line shape: `start-end perms offset dev inode [path]` — an anonymous mapping
 * has no sixth field.
 */
export function parseProcMaps(text: string): ProcMapsSummary {
  let heapBytes = 0
  let anonMappings = 0
  let anonBytes = 0
  let v8PageMaps = 0
  let from = 0
  while (from < text.length) {
    let to = text.indexOf('\n', from)
    if (to === -1) to = text.length
    const line = text.slice(from, to)
    from = to + 1
    const dash = line.indexOf('-')
    const space = line.indexOf(' ')
    if (dash <= 0 || space <= dash) continue
    const size =
      Number.parseInt(line.slice(dash + 1, space), 16) - Number.parseInt(line.slice(0, dash), 16)
    if (!Number.isFinite(size)) continue
    const path = line.split(/\s+/, 6)[5]
    if (path === undefined || path === '') {
      anonMappings += 1
      anonBytes += size
      if (size === V8_PAGE_BYTES) v8PageMaps += 1
    } else if (path === '[heap]') {
      heapBytes += size
    }
  }
  return { heapBytes, anonMappings, anonBytes, v8PageMaps }
}

// ---------------------------------------------------------------------------
// V8 heap of the main isolate + the demux Worker's isolate
// ---------------------------------------------------------------------------

/** `v8.getHeapStatistics()` fields the line carries, plus per-space committed. */
export interface V8HeapReading {
  readonly totalHeapBytes: number
  readonly physicalBytes: number
  readonly mallocedBytes: number
  readonly peakMallocedBytes: number
  readonly externalBytes: number
  readonly spaces: readonly { readonly name: string; readonly committedBytes: number }[]
}

/** Read the main isolate. Probe tick only: `getHeapSpaceStatistics` walks the spaces. */
export function readV8Heap(): V8HeapReading {
  const h = getHeapStatistics()
  return {
    totalHeapBytes: h.total_heap_size,
    physicalBytes: h.total_physical_size,
    mallocedBytes: h.malloced_memory,
    peakMallocedBytes: h.peak_malloced_memory,
    externalBytes: h.external_memory,
    spaces: getHeapSpaceStatistics().map((x) => ({
      name: x.space_name,
      committedBytes: x.space_size,
    })),
  }
}

/** The demux Worker(s)' own isolate heap (see `DemuxWorkersReading`). */
export interface WorkerHeapReading {
  readonly workers: number
  readonly heapBytes: number
  readonly physicalBytes: number
  readonly usedBytes: number
  readonly maxAgeMs: number
  readonly idleTerminates: boolean
}

const SPACE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  read_only_space: 'ro',
  old_space: 'old',
  new_space: 'new',
  large_object_space: 'lo',
  new_large_object_space: 'nlo',
  code_space: 'code',
  code_large_object_space: 'clo',
  map_space: 'map',
  shared_space: 'shared',
  shared_large_object_space: 'slo',
  trusted_space: 'trusted',
  trusted_large_object_space: 'tlo',
}

/** `old:120,new:24,lo:8` — committed MB per space, empty spaces left out. */
export function formatHeapSpaces(spaces: V8HeapReading['spaces']): string {
  const parts = spaces
    .filter((x) => x.committedBytes > 0)
    .map((x) => `${SPACE_ABBREVIATIONS[x.name] ?? x.name}:${Math.round(x.committedBytes / MB)}`)
  return parts.length === 0 ? 'none' : parts.join(',')
}

// ---------------------------------------------------------------------------
// Consumer churn + rate-limited attach/detach lines
// ---------------------------------------------------------------------------

export interface ChurnReading {
  readonly opened: number
  readonly closed: number
  readonly openedByKind: Readonly<Record<string, number>>
  readonly closedByKind: Readonly<Record<string, number>>
}

/** Opened/closed consumers since the last reading; `drain()` resets. */
export class ConsumerChurn {
  private opened = 0
  private closed = 0
  private openedByKind = new Map<string, number>()
  private closedByKind = new Map<string, number>()

  recordOpen(kind: string): void {
    this.opened += 1
    this.openedByKind.set(kind, (this.openedByKind.get(kind) ?? 0) + 1)
  }

  recordClose(kind: string): void {
    this.closed += 1
    this.closedByKind.set(kind, (this.closedByKind.get(kind) ?? 0) + 1)
  }

  drain(): ChurnReading {
    const reading: ChurnReading = {
      opened: this.opened,
      closed: this.closed,
      openedByKind: Object.fromEntries(this.openedByKind),
      closedByKind: Object.fromEntries(this.closedByKind),
    }
    this.opened = 0
    this.closed = 0
    this.openedByKind = new Map()
    this.closedByKind = new Map()
    return reading
  }
}

/** The one churn counter of this process (the broker runner). */
export const consumerChurn = new ConsumerChurn()

/**
 * Sliding-window limiter for the attach/detach lines. `admit(now)` answers
 * whether this line may be written; the number of lines swallowed since the
 * last admitted one is returned with it so the next line can say so (a branch
 * that drops work names it).
 */
export function createLineLimiter(
  maxPerWindow: number,
  windowMs: number,
): (now: number) => {
  readonly admit: boolean
  readonly suppressedBefore: number
} {
  let windowStart = 0
  let inWindow = 0
  let suppressed = 0
  return (now) => {
    if (now - windowStart >= windowMs) {
      windowStart = now
      inWindow = 0
    }
    if (inWindow >= maxPerWindow) {
      suppressed += 1
      return { admit: false, suppressedBefore: 0 }
    }
    inWindow += 1
    const suppressedBefore = suppressed
    suppressed = 0
    return { admit: true, suppressedBefore }
  }
}

/** Attach/detach lines: at most this many per window, the rest are counted. */
const CONSUMER_LINES_PER_WINDOW = 40
const CONSUMER_LINES_WINDOW_MS = 60_000
const consumerLineLimiter = createLineLimiter(CONSUMER_LINES_PER_WINDOW, CONSUMER_LINES_WINDOW_MS)

/**
 * One consumer attached to / detached from a broker: counted always (the
 * `[broker-mem]` line reports opened/closed since the last line), written at
 * info under a rate limit so a step in RSS can be matched to an event. The
 * line after a suppressed burst says how many were swallowed.
 */
export function reportConsumerEvent(
  logger: IScopedLogger | null | undefined,
  event: 'attach' | 'detach',
  kind: string,
  deviceId: number | undefined,
  total: number,
  now: number = Date.now(),
): void {
  if (event === 'attach') consumerChurn.recordOpen(kind)
  else consumerChurn.recordClose(kind)
  if (logger === undefined || logger === null) return
  const verdict = consumerLineLimiter(now)
  if (!verdict.admit) return
  const suppressed =
    verdict.suppressedBefore > 0 ? ` suppressedBefore=${verdict.suppressedBefore}` : ''
  logger.info(`consumer ${event} kind=${kind} total=${total}${suppressed}`, {
    ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
  })
}

// ---------------------------------------------------------------------------
// Broker samples + aggregation
// ---------------------------------------------------------------------------

/** What one broker holds, read off the objects that own it. */
export interface BrokerMemSample {
  readonly deviceId: number | undefined
  readonly brokerId: string
  readonly ingesting: boolean
  readonly preBufferBytes: number
  readonly clipBytes: number
  readonly rtpRingBytes: number
  readonly keyframeCacheBytes: number
  readonly rtspSessions: number
  readonly writeQueueSumBytes: number
  readonly writeQueueMaxBytes: number
  /** annex-B + RTP encoded subscribers, tallied by attribution kind. */
  readonly encodedByKind: Readonly<Record<string, number>>
  readonly audioSubscribers: number
  readonly pipeClients: number
  readonly annexBPlaneActive: boolean
}

export interface SlabReading {
  readonly live: number
  readonly free: number
  /** New slab ArrayBuffers since the previous line: ~0 once the rings are warm. */
  readonly allocsDelta: number
}

export interface BrokerMemInputs {
  readonly samples: readonly BrokerMemSample[]
  readonly webrtcSessions: number
  readonly egressTranscodes: number
  /** `process.getActiveResourcesInfo()` — live child processes etc. */
  readonly childProcesses: number
  readonly proc: {
    readonly status: ProcStatusMem | null
    readonly maps: ProcMapsSummary | null
  }
  readonly churn: ChurnReading
  readonly copied: CopyOwnedTotals
  /**
   * Packet slabs (`slab-pool.ts`): in service, recycled and waiting, and the
   * ArrayBuffers allocated since the previous line. Absent = fields omitted.
   */
  readonly slabs?: SlabReading
  /** Main isolate V8 view; absent in callers that do not read it. */
  readonly v8?: V8HeapReading | null
  /** Demux Worker isolate view; absent in callers that do not read it. */
  readonly worker?: WorkerHeapReading | null
  /** Per-WebRTC-session backing-store readings (`session-mem.ts`); absent = no group. */
  readonly sessions?: readonly SessionMemReading[]
  /** `process.memoryUsage().arrayBuffers`; absent = field omitted. */
  readonly arrayBuffersBytes?: number
}

/** Sessions kept on the line, by distinct backing bytes pinned. */
export const BROKER_MEM_TOP_SESSIONS = 3

function ringBytesOf(s: BrokerMemSample): number {
  return s.preBufferBytes + s.clipBytes + s.rtpRingBytes + s.keyframeCacheBytes
}

function mb(bytes: number): string {
  return (bytes / MB).toFixed(1)
}

function kindList(counts: Readonly<Record<string, number>>): string {
  const keys = Object.keys(counts).sort()
  return keys.length === 0 ? 'none' : keys.map((k) => `${k}:${counts[k]}`).join(',')
}

/** One greppable `key=value` line; no per-device breakdown beyond the top N. */
export function formatBrokerMem(input: BrokerMemInputs): string {
  const { samples, proc, churn, copied } = input
  const consumers: Record<string, number> = {}
  let rtsp = 0
  let audio = 0
  let pipe = 0
  let ingesting = 0
  let planes = 0
  let pre = 0
  let clip = 0
  let rtp = 0
  let kf = 0
  let qSum = 0
  let qMax = 0
  for (const s of samples) {
    if (s.ingesting) ingesting += 1
    if (s.annexBPlaneActive) planes += 1
    rtsp += s.rtspSessions
    audio += s.audioSubscribers
    pipe += s.pipeClients
    pre += s.preBufferBytes
    clip += s.clipBytes
    rtp += s.rtpRingBytes
    kf += s.keyframeCacheBytes
    qSum += s.writeQueueSumBytes
    if (s.writeQueueMaxBytes > qMax) qMax = s.writeQueueMaxBytes
    for (const [kind, n] of Object.entries(s.encodedByKind))
      consumers[kind] = (consumers[kind] ?? 0) + n
  }
  const top = [...samples]
    .filter((s) => s.deviceId !== undefined)
    .sort((a, b) => ringBytesOf(b) - ringBytesOf(a))
    .slice(0, BROKER_MEM_TOP_CAMERAS)
    .map((s) => `${s.deviceId}:${mb(ringBytesOf(s))}`)
    .join(',')

  const parts: string[] = ['[broker-mem]']
  if (proc.status !== null) {
    parts.push(
      `rssAnonMb=${(proc.status.rssAnonKb / 1024).toFixed(0)}`,
      `rssFileMb=${(proc.status.rssFileKb / 1024).toFixed(0)}`,
    )
  }
  if (proc.maps !== null) {
    parts.push(
      `heapMapMb=${mb(proc.maps.heapBytes)}`,
      `anonMaps=${proc.maps.anonMappings}`,
      `anonMapsMb=${mb(proc.maps.anonBytes)}`,
      `v8PageMaps=${proc.maps.v8PageMaps}`,
    )
  }
  const v8 = input.v8
  if (v8 !== undefined && v8 !== null) {
    parts.push(
      `v8TotalHeapMb=${mb(v8.totalHeapBytes)}`,
      `v8PhysicalMb=${mb(v8.physicalBytes)}`,
      `v8MallocedMb=${mb(v8.mallocedBytes)}`,
      `v8PeakMallocedMb=${mb(v8.peakMallocedBytes)}`,
      `v8ExternalMb=${mb(v8.externalBytes)}`,
      `spaces=${formatHeapSpaces(v8.spaces)}`,
    )
  }
  const w = input.worker
  if (w !== undefined && w !== null) {
    parts.push(
      `workers=${w.workers}`,
      `workerHeapMb=${mb(w.heapBytes)}`,
      `workerPhysicalMb=${mb(w.physicalBytes)}`,
      `workerUsedMb=${mb(w.usedBytes)}`,
      `workerAgeS=${Math.round(w.maxAgeMs / 1000)}`,
      `workerIdleExit=${w.idleTerminates ? 'yes' : 'never'}`,
    )
  }
  parts.push(
    `brokers=${samples.length}`,
    `ingesting=${ingesting}`,
    `annexBPlanes=${planes}`,
    `rtsp=${rtsp}`,
    `webrtc=${input.webrtcSessions}`,
    `encoded=${kindList(consumers)}`,
    `audioSubs=${audio}`,
    `pipeClients=${pipe}`,
    `egress=${input.egressTranscodes}`,
    `children=${input.childProcesses}`,
    `opened=${churn.opened}`,
    `closed=${churn.closed}`,
    `openedKinds=${kindList(churn.openedByKind)}`,
    `closedKinds=${kindList(churn.closedByKind)}`,
    `preBufferMb=${mb(pre)}`,
    `clipMb=${mb(clip)}`,
    `rtpRingMb=${mb(rtp)}`,
    `keyframeMb=${mb(kf)}`,
    `writeQueueSumMb=${mb(qSum)}`,
    `writeQueueMaxMb=${mb(qMax)}`,
    `copiedPackets=${copied.packets}`,
    `copiedMb=${mb(copied.bytes)}`,
    `topRingMb=${top === '' ? 'none' : top}`,
  )
  if (input.slabs !== undefined) {
    parts.push(
      `slabs=${input.slabs.live}/${input.slabs.free}`,
      `slabAllocs=${input.slabs.allocsDelta}`,
    )
  }
  const sessions = input.sessions
  if (sessions !== undefined) parts.push(...formatSessionMem(sessions, input))
  return parts.join(' ')
}

/**
 * Sums over every WebRTC session, each distinct backing store counted once PER
 * SESSION, and the three views of the NACK history so pinning shows:
 * `rtpCachePayloadMb` (what the packets say), `rtpCacheNaiveMb` (each entry's
 * own backing, a shared slab repeated) and `rtpCacheBackingMb` (each slab once).
 * `fragMb` is the brk heap NOT explained by v8 external memory.
 */
function formatSessionMem(
  sessions: readonly SessionMemReading[],
  input: BrokerMemInputs,
): string[] {
  let rtpEntries = 0
  let rtpPayload = 0
  let rtpNaive = 0
  let rtpBacking = 0
  let pushFrames = 0
  let pushBacking = 0
  let replayPackets = 0
  let replayBacking = 0
  let scrubPayload = 0
  let scrubBacking = 0
  for (const r of sessions) {
    rtpEntries += r.rtpCache.entries
    rtpPayload += r.rtpCache.payloadBytes
    rtpNaive += r.rtpCache.naiveBackingBytes
    rtpBacking += r.rtpCache.distinctBackingBytes
    pushFrames += r.pushQueue.entries
    pushBacking += r.pushQueue.distinctBackingBytes
    replayPackets += r.rtpReplay.entries
    replayBacking += r.rtpReplay.distinctBackingBytes
    scrubPayload += r.scrub.payloadBytes
    scrubBacking += r.scrub.distinctBackingBytes
  }
  const top = [...sessions]
    .sort((a, b) => sessionBackingBytes(b) - sessionBackingBytes(a))
    .slice(0, BROKER_MEM_TOP_SESSIONS)
    .map((r) => `${r.deviceId ?? 'x'}:${mb(sessionBackingBytes(r))}`)
    .join(',')
  const parts = [
    `rtpCacheEntries=${rtpEntries}`,
    `rtpCachePayloadMb=${mb(rtpPayload)}`,
    `rtpCacheNaiveMb=${mb(rtpNaive)}`,
    `rtpCacheBackingMb=${mb(rtpBacking)}`,
    `pushQueueFrames=${pushFrames}`,
    `pushQueueBackingMb=${mb(pushBacking)}`,
    `rtpReplayPackets=${replayPackets}`,
    `rtpReplayBackingMb=${mb(replayBacking)}`,
    `scrubPayloadMb=${mb(scrubPayload)}`,
    `scrubBackingMb=${mb(scrubBacking)}`,
  ]
  if (input.arrayBuffersBytes !== undefined) {
    parts.push(`arrayBuffersMb=${mb(input.arrayBuffersBytes)}`)
  }
  if (input.proc.maps !== null && input.v8 !== undefined && input.v8 !== null) {
    parts.push(`fragMb=${mb(input.proc.maps.heapBytes - input.v8.externalBytes)}`)
  }
  parts.push(`topSessionMb=${top === '' ? 'none' : top}`)
  return parts
}

/** Count entries named `name` in `process.getActiveResourcesInfo()`. */
export function countActiveResources(resources: readonly string[], name: string): number {
  let n = 0
  for (const r of resources) if (r === name) n += 1
  return n
}
