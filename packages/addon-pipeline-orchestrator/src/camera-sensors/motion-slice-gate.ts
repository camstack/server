/**
 * May the orchestrator write a camera's `motion` slice yet? (D696)
 *
 * A runner older than D696 writes the slice from its phase machine. The
 * orchestrator writes it with the effective motion. Two writers of one slice
 * are forbidden at every step of a rollout or rollback, so the orchestrator
 * writes only while EVERY counted runner node has ANSWERED that it no longer
 * writes it: `getLocalLoad().motionSliceWriter === 'orchestrator'`. The gate
 * FAILS CLOSED: whatever it cannot vouch for (an unanswered node, a field a
 * framework hop stripped) leaves no orchestrator writer, never a second one.
 *
 * Cluster-wide, not per node: on-motion sessions are balanced per episode and
 * standing attaches move on failover, so any camera may be attached on any
 * runner node, agents included. A per-node gate could not stop an old runner
 * on another node from writing a camera the orchestrator also writes.
 *
 * A node's verdict:
 * - answered with the field: it does not write;
 * - answered without it: an OLD runner, which writes (`old-runner`);
 * - never answered: unknown, so it blocks (`unanswered`);
 * - a later read that FAILED changes nothing: the node keeps its last answer
 *   (D49). A failure never reopens a gate an old runner closed, never closes
 *   one a new runner opened, and never excludes a node.
 *
 * Which nodes count (review F2, D58): every known runner node EXCEPT one the
 * registry POSITIVELY reports offline — listed with `isOnline: false` in
 * `nodes.directory` (the hub's in-memory registry, never `nodes.topology`), or
 * named by an `AgentOffline`. An offline node cannot reach the hub's
 * `setCapSlice`, so it cannot be a second writer. A node the directory does not
 * list is unknown, not offline, and still counts. The exclusion is never
 * sticky (re-review R1): a node that ANSWERS a census is online and counts at
 * once, and a directory read that began before the node's latest sign of life
 * (a connect, an answer) cannot exclude it.
 *
 * When a node's runner process comes (back) up, its answer is FORGOTTEN, so the
 * gate closes before that runner can attach a camera and write. Production
 * says so in three ways (review F1; see `agent-registry.service.ts`
 * `classifyNode`):
 * - `AgentOnline { agentId }` for a bare agent id (an agent reconnects) — this
 *   path calls `forgetNode` directly, not through {@link isRunnerProcess};
 * - `WorkerOnline { workerId }` for `<node>/detection`: the runner's own
 *   forked process, on the hub or on an agent (the UDS registry emits it at the
 *   child's pre-init register). Any OTHER child is ignored ({@link isRunnerProcess},
 *   R1-M1): a decoder or provider restart cannot bring a slice writer back;
 * - the node's `pipeline-executor` readiness going `ready` with a new epoch —
 *   the `detection` group, where the runner lives, came up — which is the
 *   transition `NodeLifecycleHandler` re-attaches cameras on. That one forgets
 *   SYNCHRONOUSLY, before any re-attach.
 * The matching `…Offline` events forget too. A forget is per NODE (the runner
 * reports its node, not its process), so a RUNNER respawn closes the gate for
 * one census; the reopening re-publishes every camera (a known level is
 * re-written as it was, an unknown one is read first).
 *
 * The answers come from the load census the orchestrator already runs (every
 * session dispatch, the admin load view), plus `refresh` on boot, on every
 * process (dis)connect and runner readiness, and `refreshIfStale` from a motion
 * edge seen while the gate is closed. Re-attach never waits on a census (D49: a
 * failed census must never block detection): a closed gate means no
 * orchestrator write, and the runner is then the only writer. There are no
 * timers: a census is asked for by an event, never by a clock (D3).
 */
import type { IScopedLogger, RunnerLocalLoad } from '@camstack/types'

/** One node of a census: what it answered, or `null` when the read failed or timed out. */
export interface RunnerLoadAnswer {
  readonly nodeId: string
  readonly load: RunnerLocalLoad | null
}

/** One row of the registry's node directory (`nodes.directory`). */
export interface DirectoryEntry {
  readonly id: string
  readonly isOnline: boolean
}

/** Why a node keeps the gate closed. */
export type MotionSliceGateBlock = 'old-runner' | 'unanswered'

export interface MotionSliceGateBlocker {
  readonly nodeId: string
  readonly reason: MotionSliceGateBlock
}

/** Why a census was asked for (said on the gate lines). */
export type MotionSliceGateRefreshReason =
  | 'boot'
  | 'agent-online'
  | 'agent-offline'
  | 'worker-online'
  | 'worker-offline'
  | 'runner-ready'
  | 'motion-edge'

export interface MotionSliceWriterGateDeps {
  readonly logger: IScopedLogger
  /** Every runner node the orchestrator knows (`topology.collectRunnerNodeIds`). */
  readonly runnerNodeIds: () => readonly string[]
  /** Run the load census; its answers come back through `noteCensus`. */
  readonly census: () => Promise<void>
  /** The registry's node list (`nodes.directory`); a throw is unanswered and changes nothing. */
  readonly readDirectory: () => Promise<readonly DirectoryEntry[]>
  readonly now: () => number
  readonly onChange: (open: boolean) => void
}

/**
 * How old the last census may be before a motion edge, seen while the gate is
 * closed, asks for another one. It bounds the census cost to one per window
 * while motion flows, and it bounds the handover gap (D696).
 */
export const GATE_STALE_REFRESH_MS = 30_000

/** A node still unanswered after this many censuses is a WARN, then every `BLOCKED_SAY_EVERY`th. */
const BLOCKED_SAY_AFTER = 2
const BLOCKED_SAY_EVERY = 20

/**
 * The runner's own child id: `pipeline-runner` runs in the `detection`
 * execution group (`addon-pipeline`'s manifest; `resolveRunnerId` → the group).
 */
export const RUNNER_CHILD_ID = 'detection'

/**
 * Is this `WorkerOnline` / `WorkerOffline` id the RUNNER's process — the only
 * child whose (re)start can bring a writer of the slice back (R1-M1)?
 *
 * Production always keys workers `<node>/<childId>` (`LocalChildRegistry`). A
 * bare id is never a Worker event: an agent reconnect is `AgentOnline`, and
 * that path calls `forgetNode` directly. A decoder, a provider or any other
 * child is not the runner: forgetting its node closed the fleet-wide gate for
 * a census and re-published every camera, for nothing. The runner is ALSO
 * covered without this event by its `pipeline-executor` readiness epoch
 * (`onRunnerReady`), so a dropped `WorkerOnline` loses nothing.
 */
export function isRunnerProcess(processId: string): boolean {
  const slash = processId.indexOf('/')
  return slash !== -1 && processId.slice(slash + 1) === RUNNER_CHILD_ID
}

function nodeOf(processNodeId: string): string {
  return processNodeId.split('/')[0] ?? processNodeId
}

export class MotionSliceWriterGate {
  readonly #deps: MotionSliceWriterGateDeps
  /** Per node: `true` = it answered that it does not write; `false` = an old runner. */
  readonly #answers: Map<string, boolean> = new Map()
  /** Nodes the registry positively reports offline. */
  readonly #offline: Set<string> = new Set()
  /**
   * Per node: bumped whenever the node shows it is up (a forget on connect, an
   * ANSWERED census). A directory read taken before the bump is older than that
   * evidence and cannot mark the node offline (re-review R1).
   */
  readonly #generation: Map<string, number> = new Map()
  /** Per unanswered node: how many censuses it has blocked through (the WARN's sampling). */
  readonly #blockedCensuses: Map<string, number> = new Map()
  #open = false
  /** The last (open, blocking) said, so each change is said once. */
  #said: string | null = null
  #inFlight: Promise<void> | null = null
  #again = false
  #lastCensusAt: number | null = null

  constructor(deps: MotionSliceWriterGateDeps) {
    this.#deps = deps
  }

  isOpen(): boolean {
    return this.#open
  }

  /** A census came back. An unanswered node keeps its last answer. */
  noteCensus(entries: readonly RunnerLoadAnswer[]): void {
    for (const entry of entries) {
      if (entry.load === null) continue
      this.#answers.set(entry.nodeId, entry.load.motionSliceWriter === 'orchestrator')
      // A node that ANSWERED is online, whatever the directory last said: an old
      // runner answering must close the gate, never stay excluded (re-review R1).
      this.#offline.delete(entry.nodeId)
      this.#bump(entry.nodeId)
    }
    this.reevaluate()
    this.#sayStillBlocked()
  }

  /** The registry's directory ANSWERED: a node listed offline stops counting; one listed online counts. */
  noteDirectory(entries: readonly DirectoryEntry[]): void {
    this.#applyDirectory(entries, new Map(this.#generation))
  }

  /** `AgentOffline`: the registry's positive statement that a node is gone. */
  noteOffline(nodeId: string): void {
    this.#offline.add(nodeOf(nodeId))
    this.#answers.delete(nodeOf(nodeId))
    this.reevaluate()
  }

  /**
   * A process of a node came up or left, or the node's runner went ready with a
   * new epoch: that node's answer is forgotten, and it counts again (it is not
   * offline: something of it just spoke). The gate closes at once, before
   * anything can re-attach a camera there, and reopens only on a fresh answer.
   */
  forgetNode(processNodeId: string): void {
    const nodeId = nodeOf(processNodeId)
    this.#answers.delete(nodeId)
    this.#offline.delete(nodeId)
    this.#bump(nodeId)
    this.reevaluate()
  }

  /** The known runner nodes changed (a node joined or left): judge again. */
  reevaluate(): void {
    const nodes = this.#counted()
    const blocking = this.#blockersOf(nodes)
    for (const nodeId of this.#blockedCensuses.keys()) {
      if (!blocking.some((b) => b.nodeId === nodeId && b.reason === 'unanswered')) {
        this.#blockedCensuses.delete(nodeId)
      }
    }
    const open = nodes.length > 0 && blocking.length === 0
    const signature = JSON.stringify({ open, blocking })
    if (signature !== this.#said) {
      this.#said = signature
      if (open) {
        this.#deps.logger.info(
          'camera motion slice: writer gate open — every runner node says it does not write the slice',
          { meta: { nodes, offline: [...this.#offline] } },
        )
      } else {
        // WARN at once for an OLD runner (it writes the slice; the orchestrator
        // waits on its upgrade). A node that has not answered YET is the normal
        // state at boot and after a reconnect: info here, and a WARN of its own
        // once it has blocked through a whole census (`#sayStillBlocked`).
        const line =
          'camera motion slice: writer gate closed — a runner node still writes the slice, or has not answered'
        const extras = { meta: { nodes, blocking } }
        if (blocking.some((b) => b.reason === 'old-runner')) this.#deps.logger.warn(line, extras)
        else this.#deps.logger.info(line, extras)
      }
    }
    if (open === this.#open) return
    this.#open = open
    this.#deps.onChange(open)
  }

  /** Ask for a census now. One runs at a time; a request during it runs one more after it. */
  refresh(reason: MotionSliceGateRefreshReason): Promise<void> {
    if (this.#inFlight !== null) {
      this.#again = true
      return this.#inFlight
    }
    this.#lastCensusAt = this.#deps.now()
    const run = Promise.all([this.#census(reason), this.#directory()])
      .then(() => undefined)
      .finally(() => {
        this.#inFlight = null
        if (this.#again) {
          this.#again = false
          void this.refresh(reason)
        }
      })
    this.#inFlight = run
    return run
  }

  /** A motion edge while closed: a census, unless one ran within `GATE_STALE_REFRESH_MS`. */
  refreshIfStale(): void {
    const last = this.#lastCensusAt
    if (last !== null && this.#deps.now() - last < GATE_STALE_REFRESH_MS) return
    void this.refresh('motion-edge')
  }

  #counted(): readonly string[] {
    return this.#deps.runnerNodeIds().filter((nodeId) => !this.#offline.has(nodeId))
  }

  #blockersOf(nodes: readonly string[]): readonly MotionSliceGateBlocker[] {
    return nodes.flatMap((nodeId): MotionSliceGateBlocker[] => {
      const answer = this.#answers.get(nodeId)
      if (answer === true) return []
      return [{ nodeId, reason: answer === false ? 'old-runner' : 'unanswered' }]
    })
  }

  /** A node still unanswered through a whole census keeps every camera's slice unwritten: a WARN, sampled. */
  #sayStillBlocked(): void {
    for (const blocker of this.#blockersOf(this.#counted())) {
      if (blocker.reason !== 'unanswered') continue
      const censuses = (this.#blockedCensuses.get(blocker.nodeId) ?? 0) + 1
      this.#blockedCensuses.set(blocker.nodeId, censuses)
      const say =
        censuses === BLOCKED_SAY_AFTER ||
        (censuses > BLOCKED_SAY_AFTER && (censuses - BLOCKED_SAY_AFTER) % BLOCKED_SAY_EVERY === 0)
      if (!say) continue
      this.#deps.logger.warn(
        'camera motion slice: a runner node has not answered — no camera slice is written until it does',
        { meta: { nodeId: blocker.nodeId, censuses } },
      )
    }
  }

  async #census(reason: MotionSliceGateRefreshReason): Promise<void> {
    try {
      await this.#deps.census()
    } catch (err: unknown) {
      this.#deps.logger.warn('camera motion slice: runner census failed — the gate stands', {
        meta: { reason, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  async #directory(): Promise<void> {
    // The generations as of the read's START: evidence that arrives while it is in flight wins.
    const since = new Map(this.#generation)
    let entries: readonly DirectoryEntry[]
    try {
      entries = await this.#deps.readDirectory()
    } catch (err: unknown) {
      this.#deps.logger.debug('camera motion slice: node directory unreadable — nothing changes', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    this.#applyDirectory(entries, since)
  }

  /**
   * Apply a directory answer. An `isOnline: false` excludes a node only when no
   * newer evidence of it (a connect, an answer) arrived since the read began.
   */
  #applyDirectory(entries: readonly DirectoryEntry[], since: ReadonlyMap<string, number>): void {
    for (const entry of entries) {
      if (entry.isOnline) {
        this.#offline.delete(entry.id)
        continue
      }
      const stale = (this.#generation.get(entry.id) ?? 0) !== (since.get(entry.id) ?? 0)
      if (stale) {
        this.#deps.logger.debug(
          'camera motion slice: directory says offline, but the node spoke since the read began — kept',
          { meta: { nodeId: entry.id } },
        )
        continue
      }
      this.#offline.add(entry.id)
    }
    this.reevaluate()
  }

  #bump(nodeId: string): void {
    this.#generation.set(nodeId, (this.#generation.get(nodeId) ?? 0) + 1)
  }
}
