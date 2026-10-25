/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import {
  parseRunnerRefusals,
  RUNNER_REFUSED_EXIT_CODE,
  type RunnerRefusalReport,
} from './runner-refusal.js'
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import * as path from 'node:path'
import type { EventCatalog, KnownEventCategory } from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import type { Context, ServiceBroker, ServiceSchema } from 'moleculer'
import { getPidStats as readPidStats } from '../../process/resource-monitor.js'
import { RUNNER_RSS_BUDGET_ENV } from '../heap-watch.js'
import { CrashSupervisor } from './crash-supervisor.js'
import { getBrokerEventBus } from './event-bus.js'
import {
  invalidateHeapProfiles,
  isHeavyRunner,
  type RunnerAddonSpec,
  runnerHeapFlags,
  runnerRssBudgetMb,
} from './runner-heap-flags.js'
import { applyRunnerNativeAllocator } from './runner-native-allocator.js'
import {
  defaultProcessGroupOps,
  type GroupReapResult,
  isRunnerShutdownInProgress,
  type ProcessGroupOps,
  reapProcessGroup,
  registerRunnerGroup,
  releaseRunnerGroup,
  runnerOwnsProcessGroup,
  summarizeMembers,
} from './runner-process-group.js'

/**
 * Synchronously evict a node from Moleculer's registry. Call this right after a
 * child process exits so the parent doesn't wait for the heartbeat timeout
 * (~15s) to notice the node is gone.
 *
 * Two-step eviction:
 * 1. `nodes.disconnected()` — fires `$node.disconnected` + unregisters services.
 *    May be a no-op if the TCP transporter already detected the drop and set
 *    `available=false`, but the call is idempotent (guarded by `node.available`).
 * 2. `nodes.delete(nodeId)` — removes the node record entirely so that when the
 *    respawned process reconnects with the same nodeId, Moleculer's
 *    `processNodeInfo` sees it as a BRAND NEW node and emits `$node.connected`
 *    (not the silent `$node.updated` path that fires for "reconnected but still
 *    in registry" nodes). Without this delete, the respawned worker's capabilities
 *    were never re-registered because `$node.connected` never fired.
 */
function forceMoleculerDisconnect(broker: ServiceBroker, nodeId: string): void {
  if (broker.nodeID === nodeId) return // never evict self
  type NodeCatalog = {
    disconnected?: (nodeId: string, isUnexpected: boolean) => void
    delete?: (nodeId: string) => void
  }
  const registry = Reflect.get(broker as object, 'registry') as { nodes?: NodeCatalog } | undefined
  const nodes = registry?.nodes
  if (!nodes) return
  // Step 1: disconnect (emits $node.disconnected, unregisters services)
  if (typeof nodes.disconnected === 'function') {
    try {
      nodes.disconnected(nodeId, false)
    } catch {
      /* already gone — ok */
    }
  }
  // Step 2: delete record so next processNodeInfo is treated as a fresh node
  if (typeof nodes.delete === 'function') {
    try {
      nodes.delete(nodeId)
    } catch {
      /* non-fatal */
    }
  }
}

// `__dirname` is shimmed by tsup (`shims: true`) for both CJS and ESM
// output, so it works regardless of how the kernel bundle is loaded.

/**
 * CPU% and RSS for a set of PIDs — `/proc` on Linux, `ps -p` elsewhere.
 * One reader for the whole kernel (`process/resource-monitor.ts`): this used
 * to be a second `ps` fork of its own, from hub-main, on every
 * `$process.list` (D452).
 */
async function getPidStats(
  pids: readonly number[],
): Promise<ReadonlyMap<number, { cpu: number; memoryRss: number }>> {
  const stats = await readPidStats(pids)
  const result = new Map<number, { cpu: number; memoryRss: number }>()
  for (const [pid, s] of stats) result.set(pid, { cpu: s.cpu, memoryRss: s.memory })
  return result
}

interface SpawnedProcess {
  readonly pid: number
  readonly nodeId: string
  readonly name: string
  /**
   * Synthetic supervisor label `runner:${runnerId}` — the real list of
   * hosted addons lives on `runnerAddons`. The normal case is a size-1
   * `runnerAddons` array (one addon, one process); the media-pipeline
   * group is the sole multi-addon exception.
   */
  readonly addonId: string
  readonly addonDir: string
  /** Every addon hosted by this runner subprocess (size 1 in the normal case). */
  readonly runnerAddons: readonly RunnerAddonSpec[]
  readonly startedAt: number
  restartCount: number
  /**
   * Runner lifecycle state. `failed` is terminal — the D6 crash
   * circuit-breaker tripped (too many crashes inside `CRASH_WINDOW_MS`)
   * and the runner will NOT be respawned. `crashed` is transient — the
   * window between an exit and the next backoff respawn.
   */
  state: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed' | 'failed' | 'refused'
  /**
   * `refused` (D877): the hosted addon said, in a typed way, that it will not
   * start. Terminal like `failed`, but NOT a crash - the D6 breaker never saw
   * it - and an operator restart retries it. The reason is the addon's own.
   */
  refusal: RunnerRefusalReport | null
  /**
   * The `REFUSED:` line the runner wrote. It is honoured ONLY together with
   * exit code 78 and is dropped on any other exit (a runner that announced a
   * refusal and then died of something else did not refuse).
   */
  announcedRefusal: RunnerRefusalReport | null
  child: ChildProcess
  /** The runner leads its own process group (POSIX, D668); its pgid is its `pid`. */
  readonly ownsGroup: boolean
  /** The reap of this runner's group, once started. Memoized: every exit path shares it. */
  groupReap: Promise<void> | null
}

interface ProcessInfo {
  readonly pid: number
  readonly nodeId: string
  readonly name: string
  readonly addonId: string
  /**
   * The full list of addon ids inside this runner subprocess. Size 1 in
   * the normal one-addon-one-process case; longer only for the media
   * group. Cluster page UI expands this to render every addon under the
   * same process card so operators see what's running where.
   */
  readonly addonIds: readonly string[]
  /** Runner label — the `runnerId` this subprocess was spawned with. */
  readonly groupId: string
  readonly isolated: boolean
  readonly spawnedBy: string | null
  readonly startedAt: number
  readonly restartCount: number
  readonly state: string
  /** Why the runner is `refused` (D877); absent otherwise. */
  readonly refusal?: RunnerRefusalReport
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
}

// D6 crash circuit-breaker policy. A runner that exits unexpectedly is
// respawned with exponential backoff (capped at MAX_BACKOFF_MS) while
// the crash count inside CRASH_WINDOW_MS stays under
// MAX_CRASHES_IN_WINDOW. Once the window fills the breaker trips: the
// runner is NOT respawned and its addon is marked `failed` so the
// admin UI surfaces it instead of the hub looping forever on a buggy
// addon. A crash older than the window ages out of the count.
const MAX_BACKOFF_MS = 30_000
const CRASH_WINDOW_MS = 60_000
const MAX_CRASHES_IN_WINDOW = 5

/**
 * Subprocess spawner injected into `createProcessService`. Production
 * code passes `child_process.spawn`; tests pass a fake that records
 * the call shape and returns a stub `ChildProcess`. Centralising the
 * dependency here is the only ESM-safe way to intercept spawn — the
 * `node:child_process` module export is non-configurable so `vi.spyOn`
 * fails. The injection point is private to this module: callers don't
 * see it, so the public `createProcessService(parentNodeId, dataDir)`
 * shape stays unchanged.
 */
type SpawnFn = (command: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

interface ProcessServiceDeps {
  readonly spawnFn?: SpawnFn
  /** Group signalling + member listing. Tests inject a fake: a fake pid must never be signalled. */
  readonly processGroups?: ProcessGroupOps
  /** Platform deciding whether a runner leads a process group. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

function createProcessService(
  parentNodeId: string,
  dataDir: string,
  deps?: ProcessServiceDeps,
  parentTcpPort?: number,
  parentUdsPath?: string,
): ServiceSchema {
  const spawnFn: SpawnFn = deps?.spawnFn ?? (spawn as SpawnFn)
  const groupOps: ProcessGroupOps = deps?.processGroups ?? defaultProcessGroupOps
  const runnersOwnGroups = runnerOwnsProcessGroup(deps?.platform ?? process.platform)
  const processes = new Map<string, SpawnedProcess>()
  // Runners whose crash is waiting on its backoff respawn: no entry in `processes`,
  // but still THERE for `$process.list` (the boot check must see "crashed", not "missing").
  const backingOff = new Map<string, SpawnedProcess>()
  // In-flight group reaps per runner id (D668). A spawn for a runner id waits on this
  // first, so a new runner never co-exists with its predecessor's children — the
  // 13-minute dual-writer incident was exactly that co-existence.
  const pendingGroupReaps = new Map<string, Promise<void>>()
  // Per-runnerId lifecycle serialization. Two concurrent ops for the SAME
  // runnerId (two overlapping `camstack deploy`s firing `void restartAddon`,
  // or a deploy overlapping a crash-respawn) MUST NOT interleave: each
  // restart captures the old child, kills it, `processes.delete`s the key,
  // then `spawnRunner` re-`set`s a fresh child. Interleaved, the second
  // restart's delete evicts the first restart's freshly-spawned child from
  // the map without killing it — orphaning a live runner (and its ffmpeg
  // grandchildren). The lock forces FIFO per id, so each op re-reads the
  // CURRENT child inside the critical section and kills exactly that one.
  // The tail promise never rejects, so a failing op never wedges the queue.
  const runnerLocks = new Map<string, Promise<unknown>>()
  function withRunnerLock<T>(runnerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = runnerLocks.get(runnerId) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    runnerLocks.set(
      runnerId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }
  /** Resolve a lookup name (runnerId or hosted addonId) to its runnerId, or null. */
  function resolveRunnerName(lookupName: string): string | null {
    if (processes.has(lookupName)) return lookupName
    for (const candidate of processes.values()) {
      if (candidate.runnerAddons.some((a) => a.addonId === lookupName)) return candidate.name
    }
    return null
  }
  // D6 crash circuit-breaker — replaces the former unbounded
  // `crashTimestamps` map + inline backoff math. Keyed per runner; it
  // ages crashes out of the window and decides respawn-vs-fail.
  const crashSupervisor = new CrashSupervisor({
    windowMs: CRASH_WINDOW_MS,
    maxCrashes: MAX_CRASHES_IN_WINDOW,
    maxBackoffMs: MAX_BACKOFF_MS,
  })
  // Captured on service `started()` — needed by the crash-respawn path to
  // evict the dead child from the Moleculer registry before the respawn
  // announces with the same nodeId. Without this the bridge short-circuits
  // rediscovery because the old node is still marked alive (15s heartbeat
  // timeout), and the new worker never registers its capabilities.
  let capturedBroker: ServiceBroker | null = null

  function buildNodeId(name: string): string {
    return `${parentNodeId}/${name}`
  }

  /**
   * Emit a runner-lifecycle event on the per-broker event bus. Used by
   * the crash circuit-breaker to surface `ProcessCrashed` /
   * `ProcessRestartScheduled` (telemetry) and `AddonCrashed` (the
   * terminal trip — consumed by the admin UI's ForksTab). No-op until
   * the broker is captured (`started()`); a missed boot-window event
   * is acceptable telemetry loss — the runner `state` on `$process.*`
   * remains the authoritative status surface.
   */
  function emitRunnerEvent<C extends KnownEventCategory>(
    category: C,
    sourceId: string,
    data: EventCatalog[C],
  ): void {
    if (!capturedBroker) return
    getBrokerEventBus(capturedBroker).emit(
      createEvent(category, { type: 'core', id: sourceId, nodeId: parentNodeId }, data),
    )
  }

  /**
   * Every transition a supervisor or a boot check can settle on (D877):
   * `running` (READY), `crashed`, `failed`, `refused`. In-process telemetry - the
   * boot check re-evaluates on it and the alert centre closes a recovered runner.
   */
  function emitStateChange(entry: SpawnedProcess): void {
    emitRunnerEvent(EventCategory.ProcessStateChanged, entry.name, {
      runnerId: entry.name,
      nodeId: parentNodeId,
      addonIds: entry.runnerAddons.map((addon) => addon.addonId),
      state: entry.state,
    })
  }

  /**
   * One line per reap that found something, or that failed. An empty group is the
   * normal case after a clean stop and stays quiet at debug. The kernel cannot say
   * which device a child served — the runner id is the finest attribution it has.
   */
  function logGroupReap(runnerId: string, result: GroupReapResult): void {
    const found = result.membersAtExit
    const killed = result.killed ?? []
    const line =
      `[${runnerId}] runner group reaped {pgid=${result.pgid}, ` +
      `members=${found === null ? 'unreadable' : found.length}` +
      `${found !== null && found.length > 0 ? ` (${summarizeMembers(found)})` : ''}, ` +
      `sigkilled=${killed.length}${killed.length > 0 ? ` (${summarizeMembers(killed)})` : ''}` +
      `${result.error !== null ? `, error=${result.error}` : ''}}`
    const logger = capturedBroker?.logger
    if (result.error !== null || killed.length > 0) {
      if (logger) logger.warn(line)
      // Deliberately raw, like the EXIT line above it: a reap that had to SIGKILL or
      // failed must never be silent because the broker was not captured yet.
      else console.error(line)
    } else if ((found?.length ?? 0) > 0 || found === null) {
      logger?.info(line)
    } else {
      logger?.debug(line)
    }
  }

  /**
   * Reap a runner's process group (D668): SIGTERM, a bounded grace, SIGKILL for what
   * remains. Memoized on the entry so the `exit` handler and a stop/restart that timed
   * out waiting for that exit share one reap, and registered in `pendingGroupReaps` so
   * the next spawn under the same id waits for it. Never rejects.
   */
  function reapRunnerGroup(entry: SpawnedProcess): Promise<void> {
    if (entry.groupReap !== null) return entry.groupReap
    if (!entry.ownsGroup) {
      entry.groupReap = Promise.resolve()
      return entry.groupReap
    }
    const reap = reapProcessGroup(entry.pid, groupOps)
      .then((result) => logGroupReap(entry.name, result))
      .catch((err: unknown) => {
        capturedBroker?.logger.error(
          `[${entry.name}] runner group reap threw: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      .finally(() => {
        releaseRunnerGroup(entry.pid)
        if (pendingGroupReaps.get(entry.name) === tracked) pendingGroupReaps.delete(entry.name)
      })
    const previous = pendingGroupReaps.get(entry.name)
    const tracked = previous ? Promise.all([previous, reap]).then(() => undefined) : reap
    pendingGroupReaps.set(entry.name, tracked)
    entry.groupReap = reap
    return reap
  }

  /** Resolves once every reap started for `runnerId` has finished. */
  async function awaitPredecessorReap(runnerId: string): Promise<void> {
    await pendingGroupReaps.get(runnerId)
  }

  /**
   * Spawn ONE runner subprocess (`addon-runner.js`) that hosts the
   * `addons` set sharing a single Moleculer broker. The normal case is
   * a size-1 `addons` array — one addon, one process; the media group
   * is the sole multi-addon exception.
   *
   * Replaces the former `spawnProcess` (single-addon → `process-runner.js`)
   * and `spawnGroupProcess` (group → `group-runner.js`) — both paths
   * differed only in the runner bundle and the env shape. `addon-runner`
   * takes ONE env contract (`CAMSTACK_RUNNER_ID` + a JSON
   * `CAMSTACK_RUNNER_ADDONS` array), so this single spawner serves both.
   *
   * The D6 crash circuit-breaker governs respawns: an unexpected exit
   * is respawned with exponential backoff (capped at `MAX_BACKOFF_MS`,
   * so a buggy addon can't peg a CPU core in a tight reboot loop) while
   * the crash count inside `CRASH_WINDOW_MS` stays under
   * `MAX_CRASHES_IN_WINDOW`. On the threshold the breaker trips: the
   * runner is marked `failed` and is NOT respawned — the hub stops
   * looping forever on a broken addon and surfaces it to the admin UI.
   */
  function spawnRunner(
    runnerId: string,
    addons: readonly RunnerAddonSpec[],
    env?: Record<string, string>,
  ): SpawnedProcess {
    const nodeId = buildNodeId(runnerId)
    backingOff.delete(runnerId)

    // Resolve addon-runner.js path — in dev: this file's directory; in
    // prod: kernel dist. `addon-runner.js` is a kernel build entry point.
    const runnerPath = path.resolve(__dirname, 'addon-runner.js')

    const heavy = isHeavyRunner(addons)
    const rssBudgetMb = runnerRssBudgetMb(addons)
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CAMSTACK_RUNNER_ID: runnerId,
      CAMSTACK_RUNNER_ADDONS: JSON.stringify(addons),
      CAMSTACK_PARENT_NODE_ID: parentNodeId,
      CAMSTACK_DATA_DIR: dataDir,
      // The child must know its own class: heavy runners start the heap watch
      // + stranded-page reclaimer on themselves (kernel/heap-watch.ts —
      // `startRunnerHeapWatch`), because the uncapped media-path runners have
      // no GC pressure to return a burst's pages and ratchet to multi-GB RSS.
      CAMSTACK_RUNNER_HEAP_PROFILE: heavy ? 'heavy' : 'light',
      // Inherit the parent's log level rather than hardcoding `debug` into
      // EVERY runner — a hardcoded debug level force-forwarded every debug
      // line to `$hub.log`, amplifying the event-bus / log fan-out load.
      CAMSTACK_LOG_LEVEL: process.env['CAMSTACK_LOG_LEVEL'] ?? 'info',
      // Pass the parent broker's TCP port so the child connects to the right
      // node. When unset, addon-runner falls back to 6000 (hub default) which
      // is correct for hub-spawned runners but wrong for agent-spawned runners
      // whose brokers listen on a derived port (Bug-4).
      ...(parentTcpPort !== undefined ? { CAMSTACK_PARENT_TCP_PORT: String(parentTcpPort) } : {}),
      ...(parentUdsPath !== undefined ? { CAMSTACK_PARENT_UDS_PATH: parentUdsPath } : {}),
      // The native half of the runner's memory, which no V8 flag reaches:
      // bounded glibc arenas, plus the libvips concurrency pin that keeps the
      // arena bound from also changing sharp's threading. Set here, at spawn,
      // because glibc reads MALLOC_ARENA_MAX once at malloc init — an env var
      // added later has no effect. Full rationale + the live measurements:
      // `runner-native-allocator.ts`.
      ...applyRunnerNativeAllocator(process.env),
      ...env,
    }

    // The whole-process RSS budget, from the co-located manifests and NOWHERE else.
    // Assigned after the spread so it also OVERWRITES an inherited value, and deleted outright
    // when nobody declared one: a container-wide env var must never silently become a budget the
    // addon did not choose — that is the "invented default" this mechanism exists to refuse.
    // Absent here means the child announces itself unwatched, which is the honest report.
    if (rssBudgetMb === undefined) delete childEnv[RUNNER_RSS_BUDGET_ENV]
    else childEnv[RUNNER_RSS_BUDGET_ENV] = String(rssBudgetMb)

    // Use the parent's binary (`process.execPath`) instead of the literal
    // `'node'` so this works inside packaged Electron builds where `node`
    // isn't on PATH. The Electron main process exports
    // `ELECTRON_RUN_AS_NODE=1` into our env, which we inherit here, so
    // re-spawning the same binary correctly runs the child as Node.
    //
    // Per-placement V8 heap flags (Block D) are prepended as command-line args — reliable across
    // both plain-node (docker hub/agent) and Electron-as-node (desktop agent), unlike NODE_OPTIONS
    // which allow-lists flags. Empty for heavy runners / when tuning is disabled.
    const heapFlags = runnerHeapFlags(addons)
    capturedBroker?.logger.info(
      `[${runnerId}] heap profile: ${heavy ? 'heavy' : 'light'} flags=[${heapFlags.join(' ')}] ` +
        `arenas=${childEnv['MALLOC_ARENA_MAX'] ?? 'glibc-default'} ` +
        `vips=${childEnv['VIPS_CONCURRENCY'] ?? 'sharp-default'}`,
    )
    // `detached: true` on POSIX makes the runner a session + process-group leader
    // (pgid === its pid), so every child it spawns — ffmpeg writers, llama-server,
    // tailscaled — inherits a group the kernel can reap after the runner dies, however
    // it dies (D668). The child is NOT `unref()`'d: the parent still waits on it, still
    // gets `exit`, still reads its pipes. Windows keeps the old shape (no groups there).
    const child = spawnFn(process.execPath, [...heapFlags, runnerPath], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: runnersOwnGroups,
    })
    const ownsGroup = runnersOwnGroups && typeof child.pid === 'number' && child.pid > 1

    const entry: SpawnedProcess = {
      pid: child.pid!,
      nodeId,
      name: runnerId,
      // Synthetic supervisor label — the real list is on `runnerAddons`.
      // Anything that asks "which addon" gets a stable identifier
      // without misreporting one specific addon.
      addonId: `runner:${runnerId}`,
      addonDir: addons[0]?.addonDir ?? '',
      runnerAddons: addons,
      startedAt: Date.now(),
      restartCount: 0,
      state: 'starting',
      refusal: null,
      announcedRefusal: null,
      child,
      ownsGroup,
      groupReap: null,
    }
    if (ownsGroup) {
      // The main-process `exit` backstop and hub-main's signal handler reach the group
      // through this registry; the reap releases it.
      registerRunnerGroup(entry.pid, {
        runnerId,
        kill: groupOps.kill,
      })
    }

    // Listen for ready signal on stdout.
    // Addon logs now flow via $hub.log action — stdout is only for the
    // READY signal and unstructured addon-runner bootstrap messages.
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      const refusals = parseRunnerRefusals(nodeId, text)
      if (refusals[0] !== undefined) entry.announcedRefusal = refusals[0]
      // Only `starting` becomes `running`. A READY that lands after a stop/restart
      // already marked the runner `stopped` must not resurrect it: the exit handler
      // would then read an intentional stop as a crash and schedule a second spawn.
      if (text.includes(`READY:${nodeId}`) && entry.state === 'starting') {
        entry.state = 'running'
        emitStateChange(entry)
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      // Only forward stderr (crash traces, unhandled rejections)
      process.stderr.write(`[${runnerId}] ${data.toString()}`)
    })

    // Handle exit — D6 crash circuit-breaker. Each unexpected exit is
    // recorded; while the crash count inside `CRASH_WINDOW_MS` stays
    // under `MAX_CRASHES_IN_WINDOW` the runner is respawned with
    // exponential backoff. Once the window fills, the breaker trips:
    // the runner is left `failed` and NOT respawned — the hub no
    // longer loops forever on a buggy addon.
    child.on('exit', (code, signal) => {
      // Always-on instrumentation, deliberately raw `console.error`:
      // `capturedBroker` (the only logger handle here) can still be null
      // at this point, and an exit reason must never be swallowed. This
      // runs hub-side, so stderr already reaches the hub terminal; the
      // `capturedBroker?.logger.error` below carries the same event into
      // the structured pipeline once the broker is captured.
      console.error(
        `[process-service EXIT] runner=${runnerId} code=${String(code)} signal=${String(signal)} state=${entry.state}`,
      )
      // EVERY exit reaps the runner's group — crash, signal, clean stop, restart,
      // breaker trip (D668). A runner that died of SIGABRT ran no shutdown hook, and
      // its children are still running right now.
      const groupReap = reapRunnerGroup(entry)
      if (entry.state === 'stopped') return // intentional stop — the stopper awaits the reap

      // An orderly shutdown signals every runner group BEFORE the broker stops
      // this service (hub-main's SIGTERM handler), so the runner exits while
      // still `running`. That exit is part of the shutdown: INFO, no crash
      // record, no respawn into a node that is going away.
      if (isRunnerShutdownInProgress()) {
        entry.state = 'stopped'
        emitStateChange(entry)
        capturedBroker?.logger.info(
          `[${runnerId}] Process exited during shutdown (code=${code}, signal=${signal})`,
          { tags: { runnerId } },
        )
        return
      }

      // A refusal (D877) is not a crash: no breaker, no respawn, no backoff.
      // The runner waits in `refused` with its reason until an operator acts.
      // The exit code is the authority; the stdout line only supplies the words.
      const announced = entry.announcedRefusal
      entry.announcedRefusal = null
      if (code === RUNNER_REFUSED_EXIT_CODE) {
        const refusal: RunnerRefusalReport = announced ?? {
          addonId: entry.runnerAddons[0]?.addonId ?? runnerId,
          code: 'unknown',
          reason: 'the runner exited with the refusal code without saying why',
          remedy: 'Read the runner log, fix the cause, then restart the addon.',
        }
        entry.refusal = refusal
        entry.state = 'refused'
        capturedBroker?.logger.error(
          `[${runnerId}] Addon refused to start (${refusal.code}): ${refusal.reason} Not respawning; ${refusal.remedy}`,
          { tags: { runnerId } },
        )
        processes.set(runnerId, entry)
        if (capturedBroker) {
          forceMoleculerDisconnect(capturedBroker, entry.nodeId)
        }
        // A distinct event, and NO `addon.crashed`: topology, the admin UI and
        // notification crash rules must not read a refusal as a crash.
        emitRunnerEvent(EventCategory.AddonRunnerRefused, runnerId, {
          runnerId,
          nodeId: parentNodeId,
          addonIds: entry.runnerAddons.map((addon) => addon.addonId),
          code: refusal.code,
          reason: refusal.reason,
          remedy: refusal.remedy,
        })
        emitStateChange(entry)
        return
      }

      entry.state = 'crashed'
      emitStateChange(entry)
      // A non-zero code or a signal is a crash (ERROR). A code-0 exit nobody
      // asked for is still handled as one (respawned), but the runner chose to
      // leave — WARN, so a clean exit never reads like a crash in the log.
      const exitLine = `[${runnerId}] Process exited (code=${code}, signal=${signal})`
      if (code === 0 && signal === null) {
        capturedBroker?.logger.warn(`${exitLine} — unexpected clean exit, respawning`, {
          tags: { runnerId },
        })
      } else {
        capturedBroker?.logger.error(exitLine, { tags: { runnerId } })
      }

      const decision = crashSupervisor.recordCrash(runnerId)
      emitRunnerEvent(EventCategory.ProcessCrashed, runnerId, {
        processId: runnerId,
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      })

      if (decision.action === 'failed') {
        // Breaker tripped — stop respawning. Mark the runner `failed`
        // so the `$process.list` / `listByAddon` actions surface the
        // terminal state to the admin UI (ForksTab / AddonCard read
        // `process.state` straight off those actions).
        entry.state = 'failed'
        emitStateChange(entry)
        capturedBroker?.logger.error(
          `[${runnerId}] Crash circuit-breaker tripped — ${decision.crashesInWindow} crashes in ${CRASH_WINDOW_MS}ms. Not respawning.`,
        )
        // The entry is already in the map (set at the end of `spawnRunner`
        // and never removed on the failure path) — this idempotent set
        // leaves it there so the failed runner stays visible in
        // `$process.list` instead of being deleted like the respawn path.
        processes.set(runnerId, entry)
        if (capturedBroker) {
          forceMoleculerDisconnect(capturedBroker, entry.nodeId)
        }
        // A RUNNER THAT GIVES UP MUST BE LOUD. The breaker itself is correct
        // (D6) and unchanged — what was missing is that it marked a runner
        // terminally `failed` in SILENCE. On 2026-08-18 the `recorder` runner
        // died of three unhandled ffmpeg spawn errors, this branch ran,
        // `/health` kept answering 200, and the fleet had no recording for
        // 3h15 until an operator's phone failed to load a clip.
        //
        // ONE event per TRIP, not per hosted addon: a group runner takes every
        // addon in it down at once and that is one outage. The Notification
        // Center's system-event intake maps this to the `addon-crash-loop`
        // kind, so an operator's existing rule carries it.
        emitRunnerEvent(EventCategory.AddonRunnerFailed, runnerId, {
          runnerId,
          nodeId: parentNodeId,
          addonIds: entry.runnerAddons.map((addon) => addon.addonId),
          crashesInWindow: decision.crashesInWindow,
          windowMs: CRASH_WINDOW_MS,
          ...(code !== null ? { exitCode: code } : {}),
          ...(signal !== null ? { signal } : {}),
        })
        // Surface the failure on the existing addon-lifecycle channel —
        // ForksTab already refreshes on `AddonCrashed`. One event per
        // hosted addon (size 1 in the normal one-addon-one-process case).
        for (const addon of entry.runnerAddons) {
          emitRunnerEvent(EventCategory.AddonCrashed, addon.addonId, {
            addonId: addon.addonId,
            error: `Crash circuit-breaker tripped after ${decision.crashesInWindow} crashes in ${CRASH_WINDOW_MS}ms`,
          })
        }
        return
      }

      capturedBroker?.logger.warn(
        `[${runnerId}] Restart scheduled (attempt #${decision.crashesInWindow}, backoff ${decision.backoffMs}ms)...`,
      )
      emitRunnerEvent(EventCategory.ProcessRestartScheduled, runnerId, {
        processId: runnerId,
        delayMs: decision.backoffMs,
      })
      processes.delete(runnerId)
      backingOff.set(runnerId, entry)
      if (capturedBroker) {
        forceMoleculerDisconnect(capturedBroker, entry.nodeId)
      }
      setTimeout(() => {
        // Serialize the crash-respawn against any concurrent operator
        // restart/stop for the same id. If one already re-created the entry
        // under the lock, skip — respawning again would orphan its child.
        void withRunnerLock(runnerId, async () => {
          // Reap BEFORE respawn: the successor must never co-exist with the dead
          // runner's children (28 orphan writers + 28 new ones, 2026-09-28).
          await groupReap
          backingOff.delete(runnerId)
          if (processes.has(runnerId)) return
          const restarted = spawnRunner(runnerId, addons, env)
          restarted.restartCount = entry.restartCount + 1
        })
      }, decision.backoffMs)
    })

    processes.set(runnerId, entry)
    return entry
  }

  return {
    name: '$process',
    actions: {
      spawnRunner: {
        async handler(
          ctx: Context<{
            runnerId: string
            addons: readonly RunnerAddonSpec[]
            env?: Record<string, string>
          }>,
        ) {
          const { runnerId, addons, env } = ctx.params
          if (processes.has(runnerId)) {
            throw new Error(`Runner "${runnerId}" already running`)
          }
          if (!Array.isArray(addons) || addons.length === 0) {
            throw new Error(`spawnRunner requires non-empty addons array`)
          }
          // A predecessor under this id may still have children being reaped (D668).
          await awaitPredecessorReap(runnerId)
          if (processes.has(runnerId)) {
            throw new Error(`Runner "${runnerId}" already running`)
          }
          // Operator-driven spawn — a deploy may have changed the addon's
          // manifest `heapProfile`, so drop any stale cached profile first.
          invalidateHeapProfiles(addons)
          const entry = spawnRunner(runnerId, addons, env)
          return {
            pid: entry.pid,
            nodeId: entry.nodeId,
            addonIds: addons.map((a) => a.addonId),
          }
        },
      },

      stop: {
        async handler(ctx: Context<{ name: string }>) {
          // Resolve the runner either by its direct key (the runner id)
          // or by addon membership (a hosted addon's id lives in
          // `runnerAddons`). Without the membership lookup, a `stop`
          // call for an addon co-located in a multi-addon runner (where
          // `runnerId !== addonId`) returns "not found" and the runner
          // subprocess leaks on uninstall. Mirrors `restart`/`listByAddon`.
          const name = resolveRunnerName(ctx.params.name)
          if (name === null) return { success: false, reason: 'not found' }
          return withRunnerLock(name, async () => {
            // Re-read the CURRENT entry inside the lock — a queued restart for
            // the same runnerId may have respawned a fresh child since we
            // resolved the name; we must kill that one, not a stale reference.
            const target = processes.get(name)
            if (!target) return { success: false, reason: 'not found' }
            const deadNodeId = target.nodeId
            // A `failed` runner (breaker tripped) and any runner whose
            // child has already exited are genuinely dead — killing a
            // dead child is a no-op and the `await` below would then
            // stall the full 5s SIGKILL-timeout fallback. Skip the kill +
            // wait-for-exit for genuinely-dead children; a live `running`
            // runner still gets killed and awaited. Matches `restartAll`.
            const alreadyDead =
              target.state === 'failed' ||
              target.state === 'refused' ||
              target.child.exitCode !== null ||
              target.child.signalCode !== null
            target.state = 'stopped'
            if (!alreadyDead) {
              target.child.kill('SIGTERM')
              // Wait for exit with timeout
              await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  target.child.kill('SIGKILL')
                  resolve()
                }, 5000)
                target.child.on('exit', () => {
                  clearTimeout(timer)
                  resolve()
                })
              })
            }
            // The runner is gone; its children are not necessarily (D668).
            await reapRunnerGroup(target)
            processes.delete(name)
            // Intentional stop — clear crash history so a future
            // `spawnRunner` with the same id starts a fresh streak
            // rather than inheriting a stale (possibly tripped) count.
            crashSupervisor.reset(name)

            // Proactively evict the dead child from Moleculer's node catalog.
            // Without this the heartbeat-based liveness check (default 15s) lets the
            // parent keep thinking the old node is alive, blocking a fresh spawn
            // on the same nodeId from registering its services.
            forceMoleculerDisconnect(ctx.broker, deadNodeId)

            return { success: true }
          })
        },
      },

      restart: {
        async handler(ctx: Context<{ name: string }>) {
          // Resolve the runner either by its direct key (the runner id)
          // or by addon membership (a hosted addon's id lives in
          // `runnerAddons`). Without the membership lookup, restart
          // calls for any addon hosted in a multi-addon runner return
          // "not found" — observed when the operator toggles
          // `requiresRestart` settings on media-group addons
          // (detection-pipeline, motion-wasm, pipeline-orchestrator etc).
          const name = resolveRunnerName(ctx.params.name)
          if (name === null) return { success: false, reason: 'not found' }
          return withRunnerLock(name, async () => {
            // Re-read the CURRENT entry inside the lock so concurrent restarts
            // serialize and each kills the live child rather than a stale
            // captured reference (the stale-runner orphan bug).
            const target = processes.get(name)
            if (!target) return { success: false, reason: 'not found' }
            const { runnerAddons } = target
            const deadNodeId = target.nodeId
            const prevRestartCount = target.restartCount
            // A `failed` runner (breaker tripped) and any runner whose
            // child has already exited are genuinely dead — `exitCode` or
            // `signalCode` is non-null. The `exit` event has already
            // fired and will NOT re-fire, so killing + awaiting it stalls
            // the full 5s SIGKILL-timeout fallback. Skip the kill +
            // wait-for-exit for genuinely-dead children; a live `running`
            // runner still gets killed and awaited. Matches `restartAll`.
            const alreadyDead =
              target.state === 'failed' ||
              target.state === 'refused' ||
              target.child.exitCode !== null ||
              target.child.signalCode !== null
            // Stop then respawn
            target.state = 'stopped'
            if (!alreadyDead) {
              target.child.kill('SIGTERM')
              await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  target.child.kill('SIGKILL')
                  resolve()
                }, 5000)
                target.child.on('exit', () => {
                  clearTimeout(timer)
                  resolve()
                })
              })
            }
            // Reap BEFORE respawn: the new runner must not co-exist with the old
            // runner's children (D668).
            await reapRunnerGroup(target)
            processes.delete(name)
            // Operator-driven restart — clear crash history so a runner
            // whose breaker had tripped (`failed`) gets a clean slate and
            // is supervised from scratch instead of re-tripping at once.
            crashSupervisor.reset(name)

            // Force-remove the old nodeId from the Moleculer registry before respawn.
            // The new child announces with the SAME nodeId; if Moleculer still thinks
            // the old node is alive (its 15s heartbeat timeout hasn't expired), the
            // CapabilityBridge short-circuits rediscovery of the new services. When
            // the delayed disconnect finally arrives it tears down the *new* provider
            // registration too — causing the "did not re-register capabilities in time"
            // timeout observed by integrations.router restart callers.
            forceMoleculerDisconnect(ctx.broker, deadNodeId)

            // Respawn the whole runner so the new child reattaches the
            // entire addon roster (size 1 in the normal case). Operator-driven
            // restart may follow a deploy that changed `heapProfile`, so drop
            // the stale cache before re-reading the manifest.
            invalidateHeapProfiles(runnerAddons)
            const restarted = spawnRunner(name, runnerAddons)
            restarted.restartCount = prevRestartCount + 1
            return { success: true, pid: restarted.pid }
          })
        },
      },

      list: {
        async handler(): Promise<readonly ProcessInfo[]> {
          const entries = [...processes.values(), ...backingOff.values()]
          const pids = entries.filter((p) => p.pid > 0).map((p) => p.pid)
          const stats = await getPidStats(pids)
          return entries.map((p) => {
            const s = stats.get(p.pid)
            return {
              pid: p.pid,
              nodeId: p.nodeId,
              name: p.name,
              addonId: p.addonId,
              addonIds: p.runnerAddons.map((a) => a.addonId),
              groupId: p.name,
              isolated: true,
              spawnedBy: p.addonId,
              startedAt: p.startedAt,
              restartCount: p.restartCount,
              state: p.state,
              ...(p.refusal !== null ? { refusal: p.refusal } : {}),
              cpuPercent: s?.cpu ?? 0,
              memoryRss: s?.memoryRss ?? 0,
              uptimeSeconds: Math.floor((Date.now() - p.startedAt) / 1000),
            }
          })
        },
      },

      restartAll: {
        async handler(): Promise<{ restarted: readonly string[]; failed: readonly string[] }> {
          const restarted: string[] = []
          const failed: string[] = []
          // Snapshot names to avoid mutation during iteration
          const names = [...processes.keys()]
          for (const name of names) {
            try {
              // Per-runner lock + re-read inside so a concurrent single
              // `restart`/`stop` for this id can't interleave and orphan a
              // freshly-spawned child (the stale-runner leak).
              await withRunnerLock(name, async () => {
                const entry = processes.get(name)
                if (!entry) return
                const { runnerAddons } = entry
                const prevRestartCount = entry.restartCount
                // A `failed` runner (breaker tripped) and any runner whose
                // child has already exited are genuinely dead — `exitCode`
                // or `signalCode` is non-null (same liveness signal the
                // `stopped()` handler relies on). Killing a dead child is a
                // no-op and the `await` below would then stall the full 5s
                // SIGKILL-timeout fallback, stacking 5s per failed runner.
                // Skip the kill + wait-for-exit for genuinely-dead children;
                // a live `running` runner still gets killed and awaited.
                const alreadyDead =
                  entry.state === 'failed' ||
                  entry.state === 'refused' ||
                  entry.child.exitCode !== null ||
                  entry.child.signalCode !== null
                if (!alreadyDead) {
                  entry.state = 'stopped'
                  entry.child.kill('SIGTERM')
                  await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                      entry.child.kill('SIGKILL')
                      resolve()
                    }, 5000)
                    entry.child.on('exit', () => {
                      clearTimeout(timer)
                      resolve()
                    })
                  })
                }
                // Reap BEFORE respawn (D668).
                await reapRunnerGroup(entry)
                processes.delete(name)
                // Operator-driven restart — clear crash history so a runner
                // whose breaker had tripped (`failed`) gets a clean slate
                // and is supervised from scratch instead of re-tripping at
                // once. Matches the single `restart` action.
                crashSupervisor.reset(name)
                // Operator-driven restart — drop any stale cached heap profile
                // so a deploy-changed manifest takes effect on respawn.
                invalidateHeapProfiles(runnerAddons)
                const respawned = spawnRunner(name, runnerAddons)
                respawned.restartCount = prevRestartCount + 1
              })
              restarted.push(name)
            } catch {
              failed.push(name)
            }
          }
          return { restarted, failed }
        },
      },

      setLogLevel: {
        handler(ctx: Context<{ level: string }>) {
          // Forward to each child process's $node-mgmt service
          for (const entry of processes.values()) {
            ctx.broker
              .call(
                '$node-mgmt.setLogLevel',
                { level: ctx.params.level },
                {
                  nodeID: entry.nodeId,
                  timeout: 5000,
                },
              )
              .catch(() => {})
          }
          return { success: true }
        },
      },

      listByAddon: {
        async handler(ctx: Context<{ addonId: string }>): Promise<readonly ProcessInfo[]> {
          // Match either the synthetic supervisor label (`runner:<id>`)
          // or any hosted addon's real id, so a query by addon id finds
          // the runner that hosts it.
          const wanted = ctx.params.addonId
          const entries = [...processes.values()].filter(
            (p) => p.addonId === wanted || p.runnerAddons.some((a) => a.addonId === wanted),
          )
          const pids = entries.filter((p) => p.pid > 0).map((p) => p.pid)
          const stats = await getPidStats(pids)
          return entries.map((p) => {
            const s = stats.get(p.pid)
            return {
              pid: p.pid,
              nodeId: p.nodeId,
              name: p.name,
              addonId: p.addonId,
              addonIds: p.runnerAddons.map((a) => a.addonId),
              groupId: p.name,
              isolated: true,
              spawnedBy: p.addonId,
              startedAt: p.startedAt,
              restartCount: p.restartCount,
              state: p.state,
              ...(p.refusal !== null ? { refusal: p.refusal } : {}),
              cpuPercent: s?.cpu ?? 0,
              memoryRss: s?.memoryRss ?? 0,
              uptimeSeconds: Math.floor((Date.now() - p.startedAt) / 1000),
            }
          })
        },
      },
    },

    started(this: { broker: ServiceBroker }) {
      // Capture the broker so the crash-respawn handler in `spawnRunner`
      // can call `forceMoleculerDisconnect` before the respawn.
      capturedBroker = this.broker
    },

    async stopped() {
      // Broker shutdown is the graceful hub/agent path: do not return to a caller
      // that may immediately `process.exit()` until every runner has exited and
      // its group has been reaped. The process-wide exit hook remains the hard,
      // synchronous fallback when shutdown itself is interrupted.
      const entries = [...processes.values()]
      await Promise.all(
        entries.map(async (entry) => {
          entry.state = 'stopped'
          const alreadyDead = entry.child.exitCode !== null || entry.child.signalCode !== null
          if (!alreadyDead) {
            entry.child.kill('SIGTERM')
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                if (entry.child.exitCode === null && entry.child.signalCode === null) {
                  capturedBroker?.logger.warn(
                    `[${entry.name}] Did not exit on SIGTERM — sending SIGKILL`,
                  )
                  entry.child.kill('SIGKILL')
                }
                resolve()
              }, 3000)
              entry.child.once('exit', () => {
                clearTimeout(timer)
                resolve()
              })
            })
          }
          await reapRunnerGroup(entry)
        }),
      )
      processes.clear()
      capturedBroker = null
    },
  }
}

export type { ProcessInfo, SpawnedProcess }
export { createProcessService }
