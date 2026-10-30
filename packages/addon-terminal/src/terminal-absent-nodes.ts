/**
 * An instance whose node left the cluster is kept and reported, never removed.
 * The alert is keyed by instance, raised once, and cleared when the node is
 * back or the operator re-pointed the instance.
 */

export interface AbsentNodeEntry {
  readonly instanceId: string
  readonly instanceName: string
  readonly nodeId: string
  readonly deviceId: number
  /** True when the instance's node is confirmed absent from the cluster. */
  readonly absent: boolean
}

export type AbsentNodeAlert = {
  readonly id: string
  readonly category: 'terminal'
  readonly severity: 'warning'
  readonly title: string
  readonly message: string
  readonly status: 'active'
  readonly read: false
  readonly createdAt: number
  readonly updatedAt: number
  readonly source: { readonly type: 'device'; readonly id: string }
  readonly metadata: {
    readonly deviceId: number
    readonly instanceId: string
    readonly nodeId: string
  }
}

export interface AbsentNodeAlertsIo {
  raise(alert: AbsentNodeAlert): Promise<void>
  clear(alertId: string): Promise<void>
  log(message: string, options: { tags: { deviceId: number }; meta: Record<string, string> }): void
}

export const absentNodeAlertId = (instanceId: string): string =>
  `terminal-node-missing:${instanceId}`

export class AbsentNodeAlerts {
  private readonly raised = new Set<string>()

  constructor(private readonly io: AbsentNodeAlertsIo) {}

  async sync(entries: readonly AbsentNodeEntry[]): Promise<void> {
    for (const entry of entries) {
      const id = absentNodeAlertId(entry.instanceId)
      if (entry.absent && !this.raised.has(entry.instanceId)) {
        const now = Date.now()
        await this.io.raise({
          id,
          category: 'terminal',
          severity: 'warning',
          title: 'Terminal node not in the cluster',
          message: `Terminal instance "${entry.instanceName}" targets node ${entry.nodeId}, which is no longer in the cluster. Edit the instance to pick another node, or delete it.`,
          status: 'active',
          read: false,
          createdAt: now,
          updatedAt: now,
          source: { type: 'device', id: String(entry.deviceId) },
          metadata: {
            deviceId: entry.deviceId,
            instanceId: entry.instanceId,
            nodeId: entry.nodeId,
          },
        })
        this.raised.add(entry.instanceId)
        this.io.log('terminal instance kept — its node is not in the cluster', {
          tags: { deviceId: entry.deviceId },
          meta: { instanceId: entry.instanceId, nodeId: entry.nodeId },
        })
      } else if (!entry.absent && this.raised.has(entry.instanceId)) {
        await this.io.clear(id)
        this.raised.delete(entry.instanceId)
      }
    }
  }

  /** The instance was deleted: its alert must not outlive it. */
  async release(instanceId: string): Promise<void> {
    if (!this.raised.delete(instanceId)) return
    await this.io.clear(absentNodeAlertId(instanceId))
  }
}
