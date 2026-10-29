import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

// ── Snapshot schemas ────────────────────────────────────────────────

const CpuBreakdownSchema = z.object({
  total: z.number(),
  user: z.number(),
  system: z.number(),
  irq: z.number(),
  nice: z.number(),
  loadAvg: z.tuple([z.number(), z.number(), z.number()]),
  cores: z.number(),
})

// `percent`, `usedBytes` and `availableBytes` are `null` when the measurement
// FAILED (D393): unknown is not 0% and not 100%. `totalBytes` is the machine's
// installed memory, which does not depend on the sample.
const MemoryInfoSchema = z.object({
  percent: z.number().nullable(),
  totalBytes: z.number(),
  usedBytes: z.number().nullable(),
  availableBytes: z.number().nullable(),
  swapUsedBytes: z.number(),
  swapTotalBytes: z.number(),
})

const DiskIoSnapshotSchema = z.object({
  readBytes: z.number(),
  writeBytes: z.number(),
  readOps: z.number(),
  writeOps: z.number(),
  timestampMs: z.number(),
})

const NetworkIoSnapshotSchema = z.object({
  rxBytes: z.number(),
  txBytes: z.number(),
  rxPackets: z.number(),
  txPackets: z.number(),
  rxErrors: z.number(),
  txErrors: z.number(),
  timestampMs: z.number(),
})

const MetricsGpuInfoSchema = z.object({
  utilization: z.number(),
  model: z.string(),
  memoryUsedBytes: z.number(),
  memoryTotalBytes: z.number(),
  temperature: z.number().nullable(),
})

const ProcessResourceInfoSchema = z.object({
  openFds: z.number(),
  threadCount: z.number(),
  activeHandles: z.number(),
  activeRequests: z.number(),
})

const PressureAvgsSchema = z.object({
  avg10: z.number(),
  avg60: z.number(),
  avg300: z.number(),
})

const PressureInfoSchema = z.object({
  some: PressureAvgsSchema,
  full: PressureAvgsSchema.nullable(),
})

const SystemResourceSnapshotSchema = z.object({
  cpu: CpuBreakdownSchema,
  memory: MemoryInfoSchema,
  gpu: MetricsGpuInfoSchema.nullable(),
  network: NetworkIoSnapshotSchema,
  disk: DiskIoSnapshotSchema,
  pressure: z.object({
    cpu: PressureInfoSchema.nullable(),
    memory: PressureInfoSchema.nullable(),
    io: PressureInfoSchema.nullable(),
  }),
  process: ProcessResourceInfoSchema,
  cpuTemperature: z.number().nullable(),
  timestampMs: z.number(),
})

const DiskSpaceInfoSchema = z.object({
  path: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  availableBytes: z.number(),
  percent: z.number(),
})

const PidResourceStatsSchema = z.object({
  pid: z.number(),
  cpu: z.number(),
  memory: z.number(),
  /**
   * Private (anonymous) resident bytes — the per-process V8 heap + native
   * allocations NOT shared with other processes (Linux RssAnon). This is the
   * "real" per-runner cost; summing it across runners is meaningful, unlike
   * `memory` (RSS), which double-counts the shared mmap'd framework code.
   * Undefined where /proc is unavailable (e.g. macOS).
   */
  privateBytes: z.number().optional(),
  /**
   * Shared file-backed resident bytes (Linux RssFile) — mmap'd framework/lib
   * code shared copy-on-write across runners. Undefined on macOS.
   */
  sharedBytes: z.number().optional(),
})

const AddonInstanceSchema = z.object({
  addonId: z.string(),
  nodeId: z.string(),
  role: z.enum(['hub', 'worker']),
  pid: z.number(),
  state: z.enum(['starting', 'running', 'stopping', 'stopped', 'crashed']),
  uptimeSec: z.number(),
})

// ── Process tree snapshot ───────────────────────────────────────────
//
// Each entry describes one OS process on the node that looks camstack-
// related. Classification is IDENTITY-driven — who the process is, never
// what its ancestry looks like:
//
//   root    — the current node's own pid (process.pid). Never killable.
//   managed — forked addon worker registered in `$process.list`. The ONLY
//             killable class: the cluster spawned it and will respawn it.
//   system  — every other camstack-shaped process on the machine. The node
//             did not spawn it and cannot name it — a container's `tini` at
//             pid 1, the operator's desktop app, a foreign tree. Never
//             killable.
//
// A fourth class, `ghost`, was removed on 2026-08-27: it produced 6 false
// positives out of 6 on the live cluster and it was the killable one. Full
// reasoning, and where NOT to restart real orphan detection from:
// `packages/system/src/builtins/native-metrics/process-classification.ts`.
const NodeProcessSchema = z.object({
  pid: z.number(),
  ppid: z.number(),
  pgid: z.number(),
  classification: z.enum(['root', 'managed', 'system']),
  /** `$process` addon binding when `managed`, else null. */
  addonId: z.string().nullable(),
  /** Kernel-reported nodeId when the process is a known agent/worker. */
  nodeId: z.string().nullable(),
  /** Truncated command line. */
  command: z.string(),
  /**
   * `ps pcpu` — CPU averaged over the process's WHOLE LIFETIME, not a rate.
   * On a runner up for days it barely moves. Fine as a column, useless as a
   * series: use `cpuMainPercent + cpuGcPercent` for anything time-varying.
   */
  cpuPercent: z.number(),
  memoryRssBytes: z.number(),
  /**
   * Instantaneous CPU% of the process's own threads over the last
   * process-snapshot window, from a `/proc/<pid>/task/*` tick delta.
   *
   * `null` = UNKNOWN, never zero: no previous sample yet (first tick after
   * boot), the pid was recycled, or this node is not Linux.
   */
  cpuMainPercent: z.number().nullable(),
  /**
   * Instantaneous CPU% of V8's `V8Worker` platform pool over the same window.
   *
   * This is the number that rewrote the 2026-08-27 diagnosis — hub-main 73%,
   * `stream-broker` 61% (`docs/architecture/load-ledger.md`). A CPU chart that
   * does not separate it from `cpuMainPercent` shows "busy" where the truth is
   * "allocating too much".
   *
   * Concurrent GC is the dominant tenant of that pool but not the only one
   * (background compilation runs there too), so it is reported as
   * "GC / V8 helpers" rather than as pure collection time. `null` has the same
   * meaning as on `cpuMainPercent`.
   */
  cpuGcPercent: z.number().nullable(),
  /** Threads seen in the tick scan. `null` under the same conditions. */
  threadCount: z.number().nullable(),
  /** Wall-clock uptime (seconds). Parsed from `ps etime`. */
  uptimeSec: z.number(),
})

// ── Container memory — the number no sum of processes can produce ────
//
// Every other memory field on this capability is PER PROCESS: `memoryRssBytes`
// on a `NodeProcess`, `privateBytes` on a `PidResourceStats`. Their sum is not
// the container's memory and never can be — page cache, shared memory and
// kernel slab are charged to the cgroup and owned by no process in the way
// `ps` counts them. On 2026-08-29 the hub's 39 processes summed to 15.81 GiB
// against a container reporting 23.14 GiB, and the ~7 GiB difference was read
// as a leak for half a day. It was page cache, shmem and slab.
//
// This is that reading, per node, per sample, on the same timestamps as the
// process snapshot — so the difference between the two is computable point by
// point instead of by hand, once, over ssh.
//
// EVERY unavailable field is `null`, never `0`. A node with no cgroup produces
// no point at all.

const ContainerMemorySnapshotSchema = z.object({
  /** Which hierarchy answered, so a reading is never ambiguous. */
  source: z.enum(['cgroup-v2', 'cgroup-v1']),
  /** `memory.current` (v2) / `memory.usage_in_bytes` (v1). Always known. */
  currentBytes: z.number(),
  /** The cgroup's ceiling. `null` = NO LIMIT — never a sentinel, never zero. */
  limitBytes: z.number().nullable(),
  /** Anonymous pages: the closest thing to "what the processes allocated". */
  anonBytes: z.number().nullable(),
  /** Page cache. Charged to the cgroup, owned by no process. */
  fileBytes: z.number().nullable(),
  /**
   * Shared memory — and the field that explained the largest single surprise.
   * The i915 driver backs GPU buffers with shmem, so an inference pool or a
   * hardware-decode session holding DRM objects is charged HERE and appears
   * nowhere in a `ps` scan.
   */
  shmemBytes: z.number().nullable(),
  /** Kernel slab charged to this cgroup. `null` on v1, which never publishes it. */
  slabBytes: z.number().nullable(),
  /**
   * Shrinkable i915 GEM object bytes, from debugfs.
   *
   * **Host-wide across every DRM client, NOT cgroup-scoped.** It is not a
   * component of `currentBytes` and must not be subtracted from it; it says
   * what put the shmem there, where `shmemBytes` only says how much.
   *
   * `null` wherever debugfs is not mounted — which is inside every camstack
   * container today — and on any node with no Intel GPU.
   */
  gpuShmemBytes: z.number().nullable(),
})

/**
 * One retained container-memory reading.
 *
 * `atMs` is the timestamp of the PROCESS snapshot taken in the same tick, not
 * a second clock: that is what makes "processes sum to X, container says Y"
 * subtractable per point rather than an eyeballed comparison of two series
 * sampled at different instants.
 *
 * A reduced window keeps the sample with the LARGEST `currentBytes` in each
 * bucket, WHOLE. Taking a per-field maximum would synthesise a row whose parts
 * never coexisted, and a mean would smear away the peak this exists to find.
 */
const ContainerMemoryPointSchema = ContainerMemorySnapshotSchema.extend({
  atMs: z.number(),
})

// ── Retained load series — hot ring + cold table, ONE reader (D251/D258) ──
//
// The series is returned already FOLDED per function and already REDUCED to
// the number of points the caller asked for. Both are server-side on purpose:
// six hours at the 10 s cadence is 2 160 raw snapshots per node, and shipping
// them to a browser that will throw most of them away is exactly the cost this
// subsystem exists to avoid.

/**
 * One point of one function's series.
 *
 * The unsuffixed fields are the bucket's **MAXIMUM**, and that choice is the
 * point of the whole surface. The two obvious reductions both lie: a mean per
 * bucket smears a spike away, and taking every Nth sample skips it outright.
 * Either would give us a tool built to find peaks that does not show peaks.
 * `...Min` carries the other end, `samples` says how many raw snapshots folded
 * into the bucket, and a mean stays derivable where it is wanted.
 *
 * An UNREDUCED point is a one-sample bucket: `samples === 1` and each `...Min`
 * equals its unsuffixed twin. Reduced and unreduced are the same shape, so a
 * caller cannot tell which it received — which is what "one reader" means.
 */
const LoadPointSchema = z.object({
  /** Bucket START, or the snapshot's own timestamp when unreduced. */
  atMs: z.number(),
  /** Raw snapshots in this bucket. Never 0 — AN EMPTY BUCKET IS ABSENT. */
  samples: z.number().int(),
  /**
   * `null` = UNKNOWN and it PROPAGATES: a bucket is null unless every process
   * of every snapshot in it reported a thread split. A partial sum is a
   * smaller number that looks exactly as real as a complete one.
   */
  cpuMainPercent: z.number().nullable(),
  cpuMainPercentMin: z.number().nullable(),
  cpuGcPercent: z.number().nullable(),
  cpuGcPercentMin: z.number().nullable(),
  /** Lifetime-average CPU%, summed. Always known — and never a rate. */
  cpuLifetimePercent: z.number(),
  cpuLifetimePercentMin: z.number(),
  memoryRssBytes: z.number(),
  memoryRssBytesMin: z.number(),
  processCount: z.number().int(),
  processCountMin: z.number().int(),
})

/** One function's series. `key` is an addonId, `__root__` or `__unattributed__`. */
const LoadFunctionSeriesSchema = z.object({
  key: z.string(),
  kind: z.enum(['addon', 'root', 'unattributed']),
  /** Oldest-first. A missing interval is MISSING — never zero-filled. */
  points: z.array(LoadPointSchema).readonly(),
})

const NodeLoadSeriesSchema = z.object({
  nodeId: z.string(),
  /** One entry per function seen in the window, heaviest-first. */
  series: z.array(LoadFunctionSeriesSchema).readonly(),
  /**
   * The CONTAINER's memory over the same window, oldest-first.
   *
   * Sits next to `series` rather than in a method of its own because the whole
   * question is a subtraction: the per-process rows in `series` sum to one
   * number and this one is another, and an operator who has to issue two calls
   * to compare them will compare two different instants. Same reader, same
   * `sinceMs`, same `bucketMs`, same timestamps.
   *
   * **EMPTY means ABSENT, never zero.** A node with no cgroup — a developer
   * Mac, a bare-metal host, a container with the hierarchy hidden — reports no
   * points at all. A zero here would be indistinguishable from a healthy
   * container and is precisely the lie this field exists to avoid.
   */
  containerMemory: z.array(ContainerMemoryPointSchema).readonly(),
  /**
   * Width of one returned bucket, in ms. Equals the sampling cadence when no
   * reduction was needed — so a caller can always say what one point covers
   * without having to know whether it was reduced.
   */
  bucketMs: z.number(),
  /** Raw snapshots that went into this answer, across both tiers. */
  retainedSamples: z.number(),
  /** Oldest snapshot represented, or `null` when nothing is retained. */
  oldestAtMs: z.number().nullable(),
  /** The fixed sampling cadence in force on the cluster, in ms. */
  cadenceMs: z.number(),
  /**
   * Did the DURABLE tier contribute? `false` means the answer is the hot ring
   * alone — an agent (which holds no table), or a store that refused.
   * Reported because "the last hour" and "the last six hours" are different
   * questions and an operator must not have to guess which was answered.
   */
  durable: z.boolean(),
})

const GetLoadSeriesInputSchema = z.object({
  /**
   * The node whose series is wanted.
   *
   * NOT named `nodeId`: the generated cap router strips a top-level
   * `nodeId` from every method input and uses it to ROUTE the call to
   * that node's provider (`generated-cap-routers.ts`). A series target
   * called `nodeId` would silently become a routing pin and never reach
   * the provider. The hub holds every node it hears from, so the
   * ordinary call is unpinned — answered by the hub, for any node.
   */
  forNodeId: z.string(),
  /**
   * EXCLUSIVE lower bound. A caller passes the newest `atMs` it already
   * holds and receives only what it is missing, so seeding a live chart
   * from this method cannot double a point already drawn.
   */
  sinceMs: z.number().optional(),
  /**
   * Most points the caller wants PER FUNCTION. The window is reduced to fit,
   * preserving min and max per bucket.
   *
   * Absent means NO reduction — legitimate for a short window and a trap for a
   * long one, which is why a chart passes its own pixel width.
   */
  maxPoints: z.number().int().positive().optional(),
})

// Public SystemMetrics summary — light-weight cached view used by UI widgets.
const SystemMetricsSchema = z.object({
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  memoryUsedMB: z.number(),
  memoryTotalMB: z.number(),
  diskPercent: z.number().optional(),
  temperature: z.number().optional(),
  gpuPercent: z.number().optional(),
  gpuMemoryPercent: z.number().optional(),
})

// ── Capability definition ───────────────────────────────────────────

export const metricsProviderCapability = {
  name: 'metrics-provider',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Fresh, full system snapshot (triggers OS-level collection). */
    collectSnapshot: method(z.void(), SystemResourceSnapshotSchema),
    /** Most recent cached snapshot from the background sampler, or null pre-first-sample. */
    getCached: method(z.void(), SystemResourceSnapshotSchema.nullable()),
    /** Light-weight cached summary for heartbeats and list views. */
    getCurrent: method(z.void(), SystemMetricsSchema),
    /** Disk space for the given mount/path. */
    getDiskSpace: method(z.object({ dirPath: z.string() }), DiskSpaceInfoSchema),
    /** GPU info (null if unavailable). */
    getGpuInfo: method(z.void(), MetricsGpuInfoSchema.nullable()),
    /** CPU temperature in °C (null if unavailable). */
    getCpuTemperature: method(z.void(), z.number().nullable()),
    /** Per-PID resource stats. Missing/dead PIDs are omitted from the result. */
    getProcessStats: method(
      z.object({ pids: z.array(z.number()) }),
      z.array(PidResourceStatsSchema),
    ),
    /**
     * List addon instances known to this node — one entry per forked worker
     * plus a synthetic 'hub' entry representing the local hub process.
     * Used by benchmarks/observability to detect whether a given addon runs
     * in its own process (measurable independently) or inline with the hub.
     */
    listAddonInstances: method(z.void(), z.array(AddonInstanceSchema).readonly()),
    /**
     * Resource stats for the process hosting the given addon.
     * Returns null when the addon runs in-process on the hub (can't measure
     * independently — caller should detect via listAddonInstances). Returns
     * hub process stats for addonId '$hub'.
     */
    getAddonStats: method(z.object({ addonId: z.string() }), PidResourceStatsSchema.nullable()),
    /**
     * Snapshot of every camstack-related process on this node with a
     * root/managed/system classification. Powers the Cluster → Agent →
     * Processes tab: cross-references `$process.list` against a `ps` scan so
     * per-addon CPU and RSS can be attributed, and so a process the cluster
     * does not manage is still visible.
     *
     * **Read-only, by design.** This cap once carried a `killProcess`
     * mutation; it was deleted on 2026-08-27. A runner's lifecycle belongs to
     * `CrashSupervisor` and is driven through `addons.restartAddon` /
     * `$process.restart` — signalling a raw pid went around the supervisor
     * (D6), and the one class it was willing to signal turned out to be the
     * container's own init and the operator's desktop app.
     */
    listNodeProcesses: method(z.void(), z.array(NodeProcessSchema).readonly()),
    /**
     * The retained per-node load series — the ONE reader over BOTH tiers.
     *
     * The in-memory ring is the HOT window (the last 180 snapshots, held by
     * every node's `native-metrics`); the hub's `metrics:node-load-samples`
     * table is the COLD one (the operator's retention, six hours by default).
     * This method merges them and DEDUPES on `atMs`, so a snapshot present in
     * both contributes once and the caller never learns which tier a point
     * came from. There is deliberately no second read surface: two readers is
     * how two charts start disagreeing about the same node.
     *
     * Reads only; nothing is sampled to answer it. Normally called UNPINNED —
     * the hub hears every node's snapshot and holds every node's rows — and
     * answers for any `forNodeId`. Pinned to an agent it answers from that
     * agent's ring alone (`durable: false`). Empty is a legitimate answer: a
     * node nobody has heard from has no series, and saying so is the truth.
     */
    getLoadSeries: method(GetLoadSeriesInputSchema, NodeLoadSeriesSchema),
    // There is NO heap-snapshot method here and none may be added — removed
    // 2026-09-03 after it took the hub down twice; `scripts/check-no-heap-dump-command.ts`
    // keeps it gone. The heap-space breakdown it used to promise is on every
    // process's periodic `[mem]` line (`kernel/heap-spaces.ts`), free.
  },
} as const satisfies CapabilityDefinition

export type IMetricsProvider = InferProvider<typeof metricsProviderCapability>

export {
  SystemMetricsSchema,
  SystemResourceSnapshotSchema,
  DiskSpaceInfoSchema,
  MetricsGpuInfoSchema,
  PidResourceStatsSchema,
  AddonInstanceSchema,
  NodeProcessSchema,
  LoadPointSchema,
  LoadFunctionSeriesSchema,
  ContainerMemorySnapshotSchema,
  ContainerMemoryPointSchema,
  NodeLoadSeriesSchema,
  GetLoadSeriesInputSchema,
  CpuBreakdownSchema,
  MemoryInfoSchema,
  DiskIoSnapshotSchema,
  NetworkIoSnapshotSchema,
  ProcessResourceInfoSchema,
  PressureInfoSchema,
}
