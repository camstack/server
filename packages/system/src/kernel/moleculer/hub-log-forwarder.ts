import { errMsg } from '@camstack/types'
import type { LogTags } from '@camstack/types'
import type { ServiceBroker } from 'moleculer'

interface LogEntry {
  timestamp: Date
  level: string
  scope?: string
  message: string
  meta?: Record<string, unknown>
  tags?: LogTags
}

/**
 * Hub Log Forwarder — forwards log entries to the hub via $hub.log.
 *
 * Listens for Moleculer node discovery events. When the hub node
 * connects, forwarding activates. When it disconnects, forwarding
 * pauses and resumes on reconnect. No timeouts — fully event-driven.
 *
 * NOTE on `console.*` below: this class IS the log transport. Its own
 * lifecycle messages (connected / disconnected / call-failed) must NOT
 * be routed through a hub-forwarding logger — that would recurse (the
 * log transport logging about itself through itself). The reference
 * `HubForwarderDestination` in `@camstack/system` solves the same problem
 * with an injected `statusLogger` that is wired to a non-forwarding
 * destination. `HubLogForwarder` has no such injection point and is
 * currently unused in the tree (exported only), so its status writes
 * stay on raw `console.*` as a deliberate, documented residual.
 */
class HubLogForwarder {
  private connected = false

  constructor(private readonly broker: ServiceBroker) {}

  async initialize(): Promise<void> {
    // Listen for node connect/disconnect — activate when $hub service appears
    this.broker.localBus.on('$node.connected', ({ node }: { node: { id: string } }) => {
      if (node.id === 'hub') {
        this.connected = true
        console.log('[HubLogForwarder] Hub connected — log forwarding active')
      }
    })

    this.broker.localBus.on('$node.disconnected', ({ node }: { node: { id: string } }) => {
      if (node.id === 'hub') {
        this.connected = false
        console.log('[HubLogForwarder] Hub disconnected — log forwarding paused')
      }
    })

    // Check if hub is already known (agent started after hub)
    try {
      const nodes = this.broker.registry?.getNodeList?.({ onlyAvailable: true }) as
        | Array<{ id: string }>
        | undefined
      if (nodes?.some((n) => n.id === 'hub')) {
        this.connected = true
        console.log('[HubLogForwarder] Hub already available — log forwarding active')
      }
    } catch {
      /* registry not available yet — wait for event */
    }
  }

  write(entry: LogEntry): void {
    if (!this.connected) return
    // Forward full tags (including pid, deviceId, etc.) so the hub renderer
    // can show the remote agent's pid in the log line and the cross-cutting
    // fields remain queryable.
    const addonIdTag = entry.tags?.addonId
    const nodeIdTag = entry.tags?.nodeId
    const mergedTags: LogTags = {
      ...entry.tags,
      pid: entry.tags?.pid ?? process.pid,
      nodeId: typeof nodeIdTag === 'string' ? nodeIdTag : this.broker.nodeID,
    }
    this.broker
      .call('$hub.log', {
        level: entry.level,
        message: entry.message,
        addonId: typeof addonIdTag === 'string' ? addonIdTag : 'agent',
        nodeId: typeof nodeIdTag === 'string' ? nodeIdTag : this.broker.nodeID,
        ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
        tags: mergedTags,
        ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
      })
      .catch((err: unknown) => {
        console.error(`[HubLogForwarder] $hub.log call failed: ${errMsg(err)}`)
      })
  }

  async shutdown(): Promise<void> {
    this.connected = false
  }
}

export { HubLogForwarder }
