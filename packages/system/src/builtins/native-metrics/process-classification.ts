/**
 * Classification of the camstack-shaped processes on one node.
 *
 * Pure: no `ps`, no broker, no clock. Everything the verdict depends on
 * arrives as an argument, so a `ps` row becoming a class is pinned by
 * `__tests__/process-classification.spec.ts` rather than by a running node.
 *
 * This is a MONITORING label and nothing else. Nothing acts on it: the
 * process-control surface (`metricsProvider.killProcess` and the kill buttons
 * in Cluster → Node → Processes) was deleted on 2026-08-27. A runner's
 * lifecycle belongs to `CrashSupervisor` and is driven through
 * `addons.restartAddon` / `$process.restart`; signalling a raw pid went around
 * the supervisor, which is the exact thing D6 exists to prevent. If a class
 * ever needs to gate an ACTION again, that is a new decision, not a
 * re-plumbing of this one.
 *
 * ── The classes ────────────────────────────────────────────────────────────
 *
 *   root    — this node's own pid.
 *   managed — a forked addon worker the kernel's `$process.list` names, so its
 *             CPU and RSS can be attributed to that addon.
 *   system  — every other camstack-shaped process on the machine: one the node
 *             did not spawn and cannot name. Reported, never attributed.
 *
 * ── What used to be here, and why it must not come back as it was ──────────
 *
 * There was a fourth class, `ghost`, produced by a `classifyByAncestry` walk:
 * a process whose ancestry reached `ppid=1` — or a parent `ps` could not see —
 * without crossing `SUPERVISOR_BOUNDARY_RE` was declared an orphan, and it was
 * the one class `killProcess` allowed.
 *
 * That boundary list was entirely a DEV-WORKSTATION list: `tsx watch …
 * launcher.ts`, the agent CLI, `concurrently`, `vite`, `npm exec`. Production
 * has none of those shapes, so the definition never had a chance to be right
 * there — it did not age out, it never knew production:
 *
 *   - in a container, pid 1 is `tini -- docker-entrypoint.sh … starter.js`. It
 *     matches the camstack command pattern, its ppid is 0, and pid 0 is not in
 *     the `ps` snapshot → ghost. Every containerised node called its own init
 *     an orphan, permanently. **The init of a container is not an orphan.**
 *   - on the desktop node, `/Applications/camstack.app` is launched by launchd
 *     (ppid 1) and its three Electron helpers hang off it → four ghosts, which
 *     were the operator's running app.
 *
 * Measured on the live cluster on 2026-08-27: 6 ghosts across three nodes, 6
 * false positives, 0 true ones. And because `ghost` was the killable class,
 * the UI's "Kill all N ghost(s)" aimed SIGKILL at pid 1 and its tree-kill
 * button aimed at the desktop app. Nothing downstream stopped either — which
 * is a large part of why the kill path is gone too.
 *
 * Detecting a REAL orphan is still a legitimate goal. Whoever picks it up:
 * do not restart from an ancestry walk gated on a hand-written list of
 * supervisor command lines. `ppid == 1` is the normal state of a container
 * init, of a launchd-started app, and of anything a service manager owns —
 * it is not evidence, and pid 1 of a container is not an orphan. Evidence
 * would be positive: a pid the cluster once spawned (it is in the runner
 * ledger) that is no longer in `$process.list` and whose runner is gone.
 * Anything less does not get to name a process disposable.
 */
import type { NodeProcess } from '@camstack/types'
import type { ThreadCpuSplit } from './thread-cpu-sampler.js'

/** The classes a node process can carry. Mirrors `NodeProcessSchema`. */
export type ProcessClassification = NodeProcess['classification']

/** One parsed `ps -eo pid,ppid,pgid,pcpu,rss,etime,command` row. */
export interface PsProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly cpuPercent: number
  readonly memoryRssBytes: number
  readonly uptimeSec: number
  readonly command: string
}

/** A pid the kernel's `$process.list` attributes to an addon runner. */
export interface ManagedProcessEntry {
  readonly addonId: string
  readonly nodeId: string
}

export interface BuildNodeProcessesInput {
  /** Every visible `ps` row on this node, camstack-shaped or not. */
  readonly psRows: readonly PsProcessRow[]
  /** This node's own pid. */
  readonly selfPid: number
  /** Node id reported for the `root` row. */
  readonly selfNodeId: string
  /** pid → addon attribution from `$process.list`. */
  readonly managed: ReadonlyMap<number, ManagedProcessEntry>
  /** pid → thread CPU split, when the sampler had an answer this tick. */
  readonly cpuSplits: ReadonlyMap<number, ThreadCpuSplit>
}

/**
 * Regex matching camstack-related command lines. We surface anything with
 * an obvious camstack fingerprint so operators can spot stray inference
 * pools, leaked tsx watchers, and zombie node workers in the Cluster →
 * Agent → Processes tab.
 *
 * Patterns mirror `scripts/hunt-zombies.sh` — keep them in sync when
 * adding a new long-lived subprocess.
 */
export const CAMSTACK_CMD_RE: RegExp =
  /(camstack|tsx\s+watch\s.*launcher\.ts|packages\/agent\/dist\/cli\.js|inference_pool\.py|bench-(inference-pool|nodeav)|node .*\/packages\/)/

/**
 * Classify one pid.
 *
 * Identity-driven, not ancestry-driven: a process is `root` because it IS
 * this node, `managed` because the kernel named it, and `system` otherwise.
 * There is no third source of truth to consult and no walk to get wrong.
 */
export function classifyProcess(
  pid: number,
  selfPid: number,
  managed: ReadonlyMap<number, ManagedProcessEntry>,
): ProcessClassification {
  if (pid === selfPid) return 'root'
  if (managed.has(pid)) return 'managed'
  return 'system'
}

/** Turn a `ps` snapshot into the node's process table. */
export function buildNodeProcesses(input: BuildNodeProcessesInput): readonly NodeProcess[] {
  const out: NodeProcess[] = []
  for (const p of input.psRows) {
    if (!CAMSTACK_CMD_RE.test(p.command)) continue
    const managed = input.managed.get(p.pid)
    const split = input.cpuSplits.get(p.pid)
    const classification = classifyProcess(p.pid, input.selfPid, input.managed)
    out.push({
      pid: p.pid,
      ppid: p.ppid,
      pgid: p.pgid,
      classification,
      addonId: managed?.addonId ?? null,
      nodeId: managed?.nodeId ?? (p.pid === input.selfPid ? input.selfNodeId : null),
      command: p.command,
      cpuPercent: p.cpuPercent,
      memoryRssBytes: p.memoryRssBytes,
      // `null`, not 0, when the split has no answer yet — the first tick
      // after boot, a recycled pid, or a non-Linux node. Zero would render
      // as "this process is idle", which is a different claim.
      cpuMainPercent: split?.mainPercent ?? null,
      cpuGcPercent: split?.gcPercent ?? null,
      threadCount: split?.threadCount ?? null,
      uptimeSec: p.uptimeSec,
    })
  }
  return out
}
