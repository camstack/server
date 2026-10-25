import type { ServiceBroker } from 'moleculer'
import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { asBrokerLike, type BrokerLike } from './event-bus.js'

// ─── Forked-runner remote-log pre-connect buffer ────────────────────────────
//
// Until the `$hub` service is discovered, `createRemoteLogger`'s `$hub.log`
// RPC would fail (no service to call). Rather than silently dropping those
// boot-time lines — which loses every log emitted during `addon.initialize()`
// — each broker gets a bounded FIFO that holds pending log payloads and is
// flushed, in emission order, the moment `setHubConnected(broker)` fires.
// Mirrors `HubForwarderDestination`'s ring-buffer (cap 500) on the agent path.
//
// State is keyed PER BROKER (by nodeID) because a single forked process can
// host multiple addon contexts sharing one broker — one `setHubConnected`
// flush must drain every remote logger created against that broker.

/** Cap on buffered pre-connect log payloads — mirrors `DEFAULT_OUTBOUND_BUFFER_SIZE`. */
const REMOTE_LOG_BUFFER_CAP = 500

/**
 * A queued log call. `send` re-dispatches the line through the originating
 * broker's `$hub.log`; it accepts the dropped-count to fold into `meta` of
 * the first flushed line (so operators see how many boot lines were lost).
 */
interface BufferedLogCall {
  send(droppedCount: number): void
}

interface HubLogState {
  connected: boolean
  /** FIFO of log calls emitted before the hub was discovered. */
  readonly buffer: BufferedLogCall[]
  /** Count of buffered entries dropped to overflow since the last flush. */
  dropped: number
}

// Per-broker hub connectivity + pre-connect buffer. In production there is
// one broker per process; tests spinning up multiple brokers each get an
// isolated entry.
const perBrokerHubState = new Map<string, HubLogState>()

// Process-wide "hub already discovered" baseline. Set when `setHubConnected`
// is called with NO broker argument (test harnesses) — any broker state
// created afterwards starts `connected: true` so its loggers forward
// directly without buffering. Production always passes the broker, so this
// stays false there and the per-broker buffer/flush path is used.
let hubConnectedDefault = false

function getHubState(brokerNodeId: string): HubLogState {
  let s = perBrokerHubState.get(brokerNodeId)
  if (!s) {
    s = { connected: hubConnectedDefault, buffer: [], dropped: 0 }
    perBrokerHubState.set(brokerNodeId, s)
  }
  return s
}

/**
 * Flush a broker's pre-connect log buffer to `$hub.log` in emission order,
 * then leave the state in `connected` so subsequent log calls forward
 * directly. The dropped-count (overflow during the buffered window) is
 * folded into the first flushed line's `meta`.
 */
function flushHubLogBuffer(state: HubLogState): void {
  const pending = state.buffer.splice(0, state.buffer.length)
  const dropped = state.dropped
  state.dropped = 0
  pending.forEach((call, index) => {
    // Only the first flushed line carries the dropped-count, so the signal
    // is visible without spamming every replayed entry.
    call.send(index === 0 ? dropped : 0)
  })
}

/**
 * Call after `broker.waitForServices('$hub')` to enable log forwarding.
 *
 * Marks the broker connected and flushes any log lines buffered during
 * the pre-discovery window. With no argument (test harnesses), every
 * known broker state is connected and flushed — the buffered entries
 * carry their own dispatch closures so no broker reference is needed.
 */
function setHubConnected(broker?: ServiceBroker): void {
  if (broker) {
    const bkr = asBrokerLike(broker)
    const state = getHubState(bkr.nodeID)
    state.connected = true
    flushHubLogBuffer(state)
    return
  }
  // No-broker call: mark the process-wide baseline connected (so brokers
  // created afterwards skip buffering) and flush every existing buffer.
  hubConnectedDefault = true
  for (const state of perBrokerHubState.values()) {
    state.connected = true
    flushHubLogBuffer(state)
  }
}

/**
 * Test-only: clear all per-broker hub-connection state + buffers and the
 * process-wide baseline so specs that create brokers in sequence start
 * from a clean slate. Production never calls this.
 */
function __resetHubConnectedForTests(): void {
  perBrokerHubState.clear()
  hubConnectedDefault = false
}
export { __resetHubConnectedForTests }

function createRemoteLogger(
  broker: BrokerLike,
  addonId: string,
  scope?: string,
  tags: LogTags = {},
): IScopedLogger {
  const bkr = broker
  // Single-string scope after the unified-logging migration. `child(x)`
  // overrides the scope (does NOT append) — same semantics as the local
  // ScopedLogger so admin-ui's LogViewer renders a stable per-addon
  // sub-component label without dealing with array shapes.
  // No default scope: addonId is already in the brand bracket ([hub/addonId]),
  // so repeating it as (addon:addonId) is noise. Scope is only set when an
  // explicit sub-component label is passed via child().
  const effectiveScope = scope
  const nodeId = bkr.nodeID
  // Forked-worker nodeIds are `parent/worker-suffix`; the agent slot is the
  // top-level parent (`hub` for children of the backend, `dev-agent-0` for
  // full remote agents). Keep them separate in the log line.
  const agentId = nodeId.includes('/') ? nodeId.split('/')[0]! : nodeId
  // pid — the forked worker's own OS pid, so log lines emitted by a
  // subprocess render with the subprocess pid (not the hub renderer pid).
  const baseTags: LogTags = { addonId, nodeId, agentId, pid: process.pid, ...tags }

  function log(level: string, message: string, extras?: LogExtras): void {
    const mergedTags: LogTags = extras?.tags ? { ...baseTags, ...extras.tags } : baseTags
    // `droppedCount` is folded into `meta` only for the first line replayed
    // out of the pre-connect buffer (`> 0`); direct forwarding passes 0.
    const dispatch = (droppedCount: number): void => {
      const meta =
        droppedCount > 0 ? { ...extras?.meta, droppedLogLines: droppedCount } : extras?.meta
      bkr
        .call('$hub.log', {
          level,
          message,
          addonId,
          nodeId,
          scope: effectiveScope,
          tags: mergedTags,
          ...(meta !== undefined ? { meta } : {}),
        })
        .catch(() => {})
    }

    const state = getHubState(nodeId)
    if (state.connected) {
      dispatch(0)
      return
    }
    // Hub not yet discovered — buffer in a bounded FIFO and flush on connect.
    // On overflow drop the OLDEST entry (mirrors HubForwarderDestination)
    // and count the drop so the next flush surfaces it.
    state.buffer.push({ send: dispatch })
    if (state.buffer.length > REMOTE_LOG_BUFFER_CAP) {
      state.buffer.splice(0, state.buffer.length - REMOTE_LOG_BUFFER_CAP)
      state.dropped++
    }
  }

  const logger: IScopedLogger = {
    info: (msg, extras) => log('info', msg, extras),
    warn: (msg, extras) => log('warn', msg, extras),
    error: (msg, extras) => log('error', msg, extras),
    debug: (msg, extras) => log('debug', msg, extras),
    child: (childScope) => createRemoteLogger(broker, addonId, childScope, baseTags),
    withTags: (extra) =>
      createRemoteLogger(broker, addonId, effectiveScope, { ...baseTags, ...extra }),
  }
  return logger
}
export { createRemoteLogger }

/**
 * Build a hub-forwarding logger for a forked-process runner (process-runner
 * / group-runner). The runner has no `AddonContext` of its own — its own
 * diagnostics ("started", "handshake failed", …) would otherwise be raw
 * `console.*` that never reaches the hub `LogManager`. This routes them
 * through the same `$hub.log` transport every addon logger uses, with the
 * Part A pre-connect buffer so boot-time lines survive.
 *
 * `scope` lets the runner tag its own lines (e.g. `process-runner`) so the
 * hub renderer distinguishes runner plumbing from the hosted addon's output.
 */
function createRunnerLogger(broker: ServiceBroker, addonId: string, scope: string): IScopedLogger {
  return createRemoteLogger(asBrokerLike(broker), addonId, scope)
}
export { createRunnerLogger }

/**
 * Test-only: build a remote logger against a structural broker spy.
 * `createRemoteLogger` only touches `broker.nodeID` + `broker.call`, so a
 * minimal stand-in is enough — this avoids spinning a real `ServiceBroker`
 * just to assert the pre-connect buffer behaviour.
 */
function __createRemoteLoggerForTests(broker: BrokerLike, addonId: string): IScopedLogger {
  return createRemoteLogger(broker, addonId)
}
export { __createRemoteLoggerForTests }

export { setHubConnected }
