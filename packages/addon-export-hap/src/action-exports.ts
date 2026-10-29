/**
 * The actions this bridge exposes (D968): the persisted selection and the
 * switch each entry is published as.
 *
 * Kept apart from the addon class so the lifecycle can be proved without a
 * HAP server: the addon supplies `publish` / `unpublish` (bridge first,
 * standalone as the fallback, exactly as for a device) and `persist` (its own
 * settings), and this class owns the rest — the lookup of the action's name,
 * the press that runs it, the refusal that is logged, the pruning of an action
 * the operator deleted.
 *
 * Actions are list entries, not devices (D954): nothing here touches the
 * device registry, and the log tag is `actionId`.
 */
import {
  type ExportEntityApi,
  type ExposedEntity,
  type IScopedLogger,
  pruneDeletedEntities,
  runExportedAction,
} from '@camstack/types'
import type { Accessory } from '@homebridge/hap-nodejs'

import { buildActionSwitch } from './action-switch.js'
import type { Mapper } from './mappers/types.js'

/** One persisted selection row, in the addon's own settings. */
export interface ActionExportEntry {
  readonly actionId: string
  readonly displayName: string
  readonly addedAt: number
}

export interface ActionExportPorts {
  readonly api: ExportEntityApi
  readonly logger: IScopedLogger
  readonly publish: (accessory: Accessory) => Promise<void>
  readonly unpublish: (accessory: Accessory) => Promise<void>
  readonly persist: (entries: readonly ActionExportEntry[]) => Promise<void>
}

const EXPORTER = 'export-hap'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ActionExports {
  private entries: readonly ActionExportEntry[]
  private readonly mappers = new Map<string, Mapper>()

  constructor(
    private readonly ports: ActionExportPorts,
    initial: readonly ActionExportEntry[],
  ) {
    this.entries = initial
  }

  /** The cap's `listExposedEntities` rows for actions. */
  list(): readonly ExposedEntity[] {
    return this.entries.map((e) => ({
      entity: { kind: 'action', actionId: e.actionId },
      exposedAs: e.displayName,
    }))
  }

  /** Re-publish the persisted selection (boot). One failure does not stop the rest. */
  async attachAll(): Promise<void> {
    for (const entry of this.entries) {
      try {
        await this.attach(entry)
      } catch (err) {
        this.ports.logger.warn('export-hap: failed to re-attach exported action on boot', {
          tags: { actionId: entry.actionId },
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  async expose(actionId: string): Promise<void> {
    const actions = await this.ports.api.actions.list.query({})
    const action = actions.find((a) => a.id === actionId)
    if (action === undefined) {
      throw new Error(`export-hap: action '${actionId}' does not exist`)
    }
    const previous = this.entries.find((e) => e.actionId === actionId)
    const entry: ActionExportEntry = {
      actionId,
      displayName: action.name,
      addedAt: previous?.addedAt ?? Date.now(),
    }
    await this.detach(actionId)
    await this.attach(entry)
    await this.save([...this.entries.filter((e) => e.actionId !== actionId), entry])
    this.ports.logger.info('export-hap: exposed action', {
      tags: { actionId },
      meta: { displayName: action.name },
    })
  }

  async unexpose(actionId: string): Promise<void> {
    await this.detach(actionId)
    if (this.entries.some((e) => e.actionId === actionId)) {
      await this.save(this.entries.filter((e) => e.actionId !== actionId))
    }
    this.ports.logger.info('export-hap: unexposed action', { tags: { actionId } })
  }

  /**
   * Drop what the operator deleted. An action list that could not be read
   * changes nothing (D49): a failed read must never destroy the selection.
   */
  async reconcile(): Promise<void> {
    if (this.entries.length === 0) return
    let live: ReadonlySet<string>
    try {
      const actions = await this.ports.api.actions.list.query({})
      live = new Set(actions.map((a) => a.id))
    } catch (err) {
      this.ports.logger.warn('export-hap: exported actions not reconciled — list unanswered', {
        meta: { error: errMsg(err) },
      })
      return
    }
    const { dropped } = pruneDeletedEntities(
      this.entries.map((e) => ({ kind: 'action' as const, actionId: e.actionId })),
      { actionIds: live, targetIds: new Set() },
      this.ports.logger,
      EXPORTER,
    )
    if (dropped.length === 0) return
    for (const ref of dropped) {
      if (ref.kind === 'action') await this.detach(ref.actionId)
    }
    const gone = new Set(dropped.flatMap((r) => (r.kind === 'action' ? [r.actionId] : [])))
    await this.save(this.entries.filter((e) => !gone.has(e.actionId)))
  }

  async dispose(): Promise<void> {
    for (const mapper of this.mappers.values()) await mapper.dispose()
    this.mappers.clear()
  }

  private async attach(entry: ActionExportEntry): Promise<void> {
    const mapper = buildActionSwitch({
      actionId: entry.actionId,
      displayName: entry.displayName,
      run: async () => {
        await runExportedAction(this.ports.api, this.ports.logger, {
          exporter: EXPORTER,
          actionId: entry.actionId,
        })
      },
    })
    for (const accessory of mapper.accessories) await this.ports.publish(accessory)
    this.mappers.set(entry.actionId, mapper)
  }

  private async detach(actionId: string): Promise<void> {
    const mapper = this.mappers.get(actionId)
    if (mapper === undefined) return
    this.mappers.delete(actionId)
    for (const accessory of mapper.accessories) await this.ports.unpublish(accessory)
    await mapper.dispose()
  }

  private async save(next: readonly ActionExportEntry[]): Promise<void> {
    this.entries = next
    await this.ports.persist(next)
  }
}
