/**
 * Actions and notification targets exported to Home Assistant (D968).
 *
 * An action is a `button`: pressing it runs the action through `actions.run`.
 * A notification target is a `notify` entity: a message sent to it goes out
 * through `notification-output.send` to that target. Both live on ONE
 * synthetic device — they are list entries, never camstack devices (D954), so
 * nothing here touches the device registry or the membership store.
 *
 * The selection is this addon's own setting. The class holds it, validates an
 * entry against the live lists, prunes what the operator deleted (a failed
 * read changes nothing, D49), and answers the commands Home Assistant sends
 * back. The addon supplies `persist` and `reconcile`, so the lifecycle is
 * testable without an Home Assistant.
 *
 * `notify` is a platform the custom component must BUILD (see
 * `component-support.ts`): against a component that does not, the targets are
 * withheld from the plan and the caller logs which ones, by name — an entity
 * announced to a component that drops it would read as "exported nothing".
 */
import {
  type ExportEntityApi,
  type ExportEntityRef,
  type ExposedEntity,
  type IScopedLogger,
  pruneDeletedEntities,
  runExportedAction,
  sendToExportedTarget,
} from '@camstack/types'

import type { PlatformSupport } from './component-support.js'
import { commandTopic, syntheticDeviceKeyFor, toComponentKey, toSlug } from './topics.js'
import type { HaComponent, HaDevicePlan } from './types.js'

/** The stable id of the synthetic device that carries them. A WIRE FORMAT. */
export const EXPORTED_ENTITIES_STABLE_ID = 'synthetic-exported-entities'

const EXPORTER = 'homeassistant-export'

export interface ExportedActionEntry {
  readonly actionId: string
  readonly displayName: string
  readonly addedAt: number
}

export interface ExportedTargetEntry {
  readonly targetId: string
  readonly displayName: string
  readonly addedAt: number
}

/** The persisted selection. */
export interface ExportedEntitiesState {
  readonly actions: readonly ExportedActionEntry[]
  readonly targets: readonly ExportedTargetEntry[]
}

export interface ExportedEntitiesPorts {
  readonly api: ExportEntityApi
  readonly logger: IScopedLogger
  readonly persist: (next: ExportedEntitiesState) => Promise<void>
  /** Re-announce the structure after the selection changed. */
  readonly reconcile: () => Promise<void>
}

export interface ExportedEntitiesPlan {
  readonly plan: HaDevicePlan | null
  /** Target ids left out because the component does not build `notify`. */
  readonly withheld: readonly string[]
}

export type ExportedCommandOutcome =
  | { readonly handled: false }
  | { readonly handled: true; readonly applied: boolean }

/** `action_<slug>` — derived from the action ID, so a rename keeps its entity. */
export function actionEntity(actionId: string): string {
  return `action_${toSlug(actionId)}`
}

/** `notify_<slug>` — derived from the target ID. */
export function targetEntity(targetId: string): string {
  return `notify_${toSlug(targetId)}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ExportedEntities {
  private state: ExportedEntitiesState

  constructor(
    private readonly ports: ExportedEntitiesPorts,
    initial: ExportedEntitiesState,
  ) {
    this.state = initial
  }

  /** The cap's `listExposedEntities` rows for actions and notifiers. */
  list(): readonly ExposedEntity[] {
    return [
      ...this.state.actions.map(
        (e): ExposedEntity => ({
          entity: { kind: 'action', actionId: e.actionId },
          exposedAs: e.displayName,
        }),
      ),
      ...this.state.targets.map(
        (e): ExposedEntity => ({
          entity: { kind: 'notifier', targetId: e.targetId },
          exposedAs: e.displayName,
        }),
      ),
    ]
  }

  async expose(entity: ExportEntityRef): Promise<void> {
    if (entity.kind === 'device') {
      throw new Error('homeassistant-export: a device is not an action or a notification target')
    }
    if (entity.kind === 'action') {
      const actions = await this.ports.api.actions.list.query({})
      const action = actions.find((a) => a.id === entity.actionId)
      if (action === undefined) {
        throw new Error(`homeassistant-export: action '${entity.actionId}' does not exist`)
      }
      const previous = this.state.actions.find((e) => e.actionId === entity.actionId)
      const entry: ExportedActionEntry = {
        actionId: entity.actionId,
        displayName: action.name,
        addedAt: previous?.addedAt ?? Date.now(),
      }
      await this.save({
        ...this.state,
        actions: [...this.state.actions.filter((e) => e.actionId !== entity.actionId), entry],
      })
      this.ports.logger.info('homeassistant-export: exposed action', {
        tags: { actionId: entity.actionId },
        meta: { displayName: action.name },
      })
    } else {
      const targets = await this.ports.api.notificationOutput.listTargets.query({})
      const target = targets.find((t) => t.id === entity.targetId)
      if (target === undefined) {
        throw new Error(
          `homeassistant-export: notification target '${entity.targetId}' does not exist`,
        )
      }
      const previous = this.state.targets.find((e) => e.targetId === entity.targetId)
      const entry: ExportedTargetEntry = {
        targetId: entity.targetId,
        displayName: target.name,
        addedAt: previous?.addedAt ?? Date.now(),
      }
      await this.save({
        ...this.state,
        targets: [...this.state.targets.filter((e) => e.targetId !== entity.targetId), entry],
      })
      this.ports.logger.info('homeassistant-export: exposed notification target', {
        tags: { targetId: entity.targetId },
        meta: { displayName: target.name },
      })
    }
    await this.ports.reconcile()
  }

  async unexpose(entity: ExportEntityRef): Promise<void> {
    if (entity.kind === 'device') {
      throw new Error('homeassistant-export: a device is not an action or a notification target')
    }
    const next: ExportedEntitiesState =
      entity.kind === 'action'
        ? {
            ...this.state,
            actions: this.state.actions.filter((e) => e.actionId !== entity.actionId),
          }
        : {
            ...this.state,
            targets: this.state.targets.filter((e) => e.targetId !== entity.targetId),
          }
    await this.save(next)
    await this.ports.reconcile()
  }

  /**
   * Drop what the operator deleted, logging each drop. A list that could not
   * be read changes nothing: a failed read must never destroy the selection.
   */
  async pruneDeleted(): Promise<void> {
    if (this.state.actions.length === 0 && this.state.targets.length === 0) return
    let actionIds: ReadonlySet<string>
    let targetIds: ReadonlySet<string>
    try {
      const [actions, targets] = await Promise.all([
        this.ports.api.actions.list.query({}),
        this.ports.api.notificationOutput.listTargets.query({}),
      ])
      actionIds = new Set(actions.map((a) => a.id))
      targetIds = new Set(targets.map((t) => t.id))
    } catch (err) {
      this.ports.logger.warn(
        'homeassistant-export: exported entities not reconciled — a list was unanswered',
        { meta: { error: errMsg(err) } },
      )
      return
    }
    const refs: ExportEntityRef[] = [
      ...this.state.actions.map((e): ExportEntityRef => ({ kind: 'action', actionId: e.actionId })),
      ...this.state.targets.map(
        (e): ExportEntityRef => ({ kind: 'notifier', targetId: e.targetId }),
      ),
    ]
    const { dropped } = pruneDeletedEntities(
      refs,
      { actionIds, targetIds },
      this.ports.logger,
      EXPORTER,
    )
    if (dropped.length === 0) return
    const goneActions = new Set(dropped.flatMap((r) => (r.kind === 'action' ? [r.actionId] : [])))
    const goneTargets = new Set(dropped.flatMap((r) => (r.kind === 'notifier' ? [r.targetId] : [])))
    await this.save({
      actions: this.state.actions.filter((e) => !goneActions.has(e.actionId)),
      targets: this.state.targets.filter((e) => !goneTargets.has(e.targetId)),
    })
  }

  /** The synthetic device the selection announces. Null when nothing is exported. */
  plan(support: PlatformSupport): ExportedEntitiesPlan {
    const deviceKey = syntheticDeviceKeyFor(EXPORTED_ENTITIES_STABLE_ID)
    const cmps: Record<string, HaComponent> = {}
    for (const e of this.state.actions) {
      const entity = actionEntity(e.actionId)
      cmps[toComponentKey('button', entity)] = {
        platform: 'button',
        unique_id: `${EXPORTED_ENTITIES_STABLE_ID}_${entity}`,
        name: e.displayName,
        command_topic: commandTopic(deviceKey, entity),
        payload_press: 'PRESS',
        icon: 'mdi:play-circle-outline',
      }
    }
    const withheld: string[] = []
    for (const e of this.state.targets) {
      if (!support.has('notify')) {
        withheld.push(e.targetId)
        continue
      }
      const entity = targetEntity(e.targetId)
      cmps[toComponentKey('notify', entity)] = {
        platform: 'notify',
        unique_id: `${EXPORTED_ENTITIES_STABLE_ID}_${entity}`,
        name: e.displayName,
        command_topic: commandTopic(deviceKey, entity),
        icon: 'mdi:message-text-outline',
      }
    }
    if (Object.keys(cmps).length === 0) return { plan: null, withheld }
    return {
      plan: {
        deviceKey,
        deviceId: null,
        dev: {
          ids: [deviceKey],
          name: 'CamStack Actions and Notifications',
          mf: 'CamStack',
          mdl: 'Synthetic',
        },
        cmps,
      },
      withheld,
    }
  }

  /** Answer a command Home Assistant sent for this device. */
  async handleCommand(entity: string, value: string): Promise<ExportedCommandOutcome> {
    const action = this.state.actions.find((e) => actionEntity(e.actionId) === entity)
    if (action !== undefined) {
      const result = await runExportedAction(this.ports.api, this.ports.logger, {
        exporter: EXPORTER,
        actionId: action.actionId,
      })
      return { handled: true, applied: result.status === 'started' }
    }
    const target = this.state.targets.find((e) => targetEntity(e.targetId) === entity)
    if (target !== undefined) {
      const result = await sendToExportedTarget(this.ports.api, this.ports.logger, {
        exporter: EXPORTER,
        targetId: target.targetId,
        notification: { body: value },
      })
      return { handled: true, applied: result.status === 'sent' }
    }
    return { handled: false }
  }

  private async save(next: ExportedEntitiesState): Promise<void> {
    this.state = next
    await this.ports.persist(next)
  }
}
