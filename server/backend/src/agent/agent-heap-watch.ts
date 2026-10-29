/**
 * The agent root's own memory, on the record and returned to the OS.
 *
 * hub-main has had the `[mem]` heartbeat and the stranded-page reclaimer since
 * 2026-08; the agent root process (container AND desktop — both reach
 * `startAgent` through the same launcher) had neither, so a measured 0.8–1.4 GB
 * agent root emitted no line at all and never gave a page back. This is the same
 * mechanism, not a second one: `startHeapWatch` with the V8 reclaimer, labelled
 * `agent-main`.
 */
import {
  AGENT_MAIN_HEAP_WATCH_LABEL,
  createV8Reclaimer,
  type HeapReclaimer,
  type HeapWatchSink,
  startHeapWatch,
} from '@camstack/system'

/** The slice of a logger the heartbeat needs. */
export interface AgentHeapWatchLogger {
  readonly info: (line: string) => void
  readonly warn: (line: string) => void
}

/** Injection points, so the wiring is testable without a real GC. */
export interface AgentHeapWatchDeps {
  readonly start: typeof startHeapWatch
  readonly createReclaimer: () => HeapReclaimer | undefined
}

const DEFAULT_DEPS: AgentHeapWatchDeps = {
  start: startHeapWatch,
  createReclaimer: createV8Reclaimer,
}

/**
 * Start the heartbeat + reclaim for the agent root. Returns the stop function.
 * `createV8Reclaimer()` returns undefined when V8 declines; the heartbeat then
 * runs report-only, exactly as hub-main does.
 */
export function startAgentHeapWatch(
  logger: AgentHeapWatchLogger,
  deps: AgentHeapWatchDeps = DEFAULT_DEPS,
): () => void {
  const reclaimer = deps.createReclaimer()
  const sink: HeapWatchSink = {
    info: (line) => {
      logger.info(line)
    },
    warn: (line) => {
      logger.warn(line)
    },
  }
  return deps.start(
    AGENT_MAIN_HEAP_WATCH_LABEL,
    sink,
    undefined,
    reclaimer === undefined ? undefined : { reclaim: reclaimer },
    undefined,
    undefined,
    // Say who chose the ceiling: the default ceiling below is applied by the
    // launcher's argv, and an absent flag means the image/desktop predates it.
    true,
  )
}
