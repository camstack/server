/**
 * Actions exported to Google Home as SCENES (D968).
 *
 * Google has no "run" verb for an arbitrary automation, but it has a scene: a
 * device of type `action.devices.types.SCENE` with the `Scene` trait, whose
 * `ActivateScene` command fires something. An action is exactly that, so it is
 * exported as a scene and ActivateScene runs `actions.run`.
 *
 * An action is a list entry, never a device (D954), so its Google id lives
 * outside the numeric device id space (`action:<id>`, which the device id
 * parser rejects) and nothing here touches the device registry.
 *
 * `actions.run` is an admin act, so only a link whose user is an ADMIN sees or
 * fires a scene; anyone else is told the device does not exist.
 *
 * Whether the run is accepted is decided by `actions.run`: an action that is
 * already running or in cooldown is refused with a named Google error (and
 * logged by `runExportedAction`) — never queued.
 *
 * Google learns a new scene only on its next SYNC; this addon cannot ask for
 * one (no HomeGraph credential, ADR 0269), so there is no push here.
 */
import {
  type ExportEntityApi,
  type ExposedEntity,
  type IScopedLogger,
  pruneDeletedEntities,
  runExportedAction,
} from '@camstack/types'

import type {
  ExecuteCommandResult,
  GoogleErrorCode,
  QueryDeviceState,
  SyncDevice,
} from './google-home/protocol.js'

const EXPORTER = 'export-google'
const PREFIX = 'action:'
const ACTIVATE_SCENE = 'action.devices.commands.ActivateScene'

/** One persisted selection row, in the addon's own settings. */
export interface ActionSceneEntry {
  readonly actionId: string
  readonly displayName: string
  readonly addedAt: number
}

export function actionSceneId(actionId: string): string {
  return `${PREFIX}${actionId}`
}

/** The action id a Google device id names, or null when it is not a scene id. */
export function parseActionSceneId(rawId: string): string | null {
  if (!rawId.startsWith(PREFIX)) return null
  const id = rawId.slice(PREFIX.length)
  return id.length === 0 ? null : id
}

export function buildActionSceneDevice(entry: ActionSceneEntry): SyncDevice {
  return {
    id: actionSceneId(entry.actionId),
    type: 'action.devices.types.SCENE',
    traits: ['action.devices.traits.Scene'],
    name: { name: entry.displayName },
    willReportState: false,
    attributes: { sceneReversible: false },
    deviceInfo: { manufacturer: 'CamStack', model: 'action' },
  }
}

export interface ActionScenePorts {
  readonly api: ExportEntityApi
  readonly logger: IScopedLogger
  /** True when the hub user behind a link is an admin. Fails closed. */
  readonly isAdminUser: (userId: string) => Promise<boolean>
  readonly persist: (entries: readonly ActionSceneEntry[]) => Promise<void>
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const NOT_FOUND_STATE: QueryDeviceState = {
  online: false,
  status: 'ERROR',
  errorCode: 'deviceNotFound',
}

function failure(rawId: string, errorCode: GoogleErrorCode) {
  return {
    ids: [rawId],
    status: 'ERROR',
    errorCode,
  } satisfies ExecuteCommandResult
}

export class ActionSceneExports {
  private entries: readonly ActionSceneEntry[]

  constructor(
    private readonly ports: ActionScenePorts,
    initial: readonly ActionSceneEntry[],
  ) {
    this.entries = initial
  }

  isExposed(actionId: string): boolean {
    return this.entries.some((e) => e.actionId === actionId)
  }

  list(): readonly ExposedEntity[] {
    return this.entries.map((e) => ({
      entity: { kind: 'action', actionId: e.actionId },
      exposedAs: e.displayName,
    }))
  }

  /** The scenes SYNC adds for this link: admins only. */
  async syncDevicesFor(userId: string): Promise<readonly SyncDevice[]> {
    if (this.entries.length === 0) return []
    if (!(await this.admin(userId))) return []
    return this.entries.map(buildActionSceneDevice)
  }

  /** QUERY for a scene: it has no state, only existence. */
  async queryScene(rawId: string, userId: string): Promise<QueryDeviceState> {
    const actionId = await this.visibleAction(rawId, userId, 'query')
    return actionId === null ? NOT_FOUND_STATE : { online: true, status: 'SUCCESS' }
  }

  /** EXECUTE for a scene: ActivateScene runs the action. */
  async executeScene(
    rawId: string,
    command: string,
    params: Readonly<Record<string, unknown>>,
    userId: string,
  ): Promise<ExecuteCommandResult> {
    const actionId = await this.visibleAction(rawId, userId, 'execute')
    if (actionId === null) return failure(rawId, 'deviceNotFound')
    // sceneReversible is false: a deactivate request is refused, not run.
    if (command !== ACTIVATE_SCENE || params['deactivate'] === true) {
      this.ports.logger.warn(
        'export-google: action scene refused — only ActivateScene is supported',
        {
          tags: { actionId },
          meta: { command },
        },
      )
      return failure(rawId, 'functionNotSupported')
    }
    const result = await runExportedAction(this.ports.api, this.ports.logger, {
      exporter: EXPORTER,
      actionId,
    })
    switch (result.status) {
      case 'started':
        return { ids: [rawId], status: 'SUCCESS' }
      case 'refused':
        if (result.reason === 'not-found') return failure(rawId, 'deviceNotFound')
        return failure(rawId, result.reason === 'already-running' ? 'inProgress' : 'deviceNotReady')
      case 'failed':
        return failure(rawId, 'hardError')
    }
  }

  async expose(actionId: string): Promise<void> {
    const actions = await this.ports.api.actions.list.query({})
    const action = actions.find((a) => a.id === actionId)
    if (action === undefined) {
      throw new Error(`export-google: action '${actionId}' does not exist`)
    }
    const entry: ActionSceneEntry = {
      actionId,
      displayName: action.name,
      addedAt: this.entries.find((e) => e.actionId === actionId)?.addedAt ?? Date.now(),
    }
    await this.save([...this.entries.filter((e) => e.actionId !== actionId), entry])
    this.ports.logger.info(
      'export-google: exposed action as a scene — visible after the next Google SYNC ("Hey Google, sync my devices")',
      { tags: { actionId }, meta: { displayName: action.name } },
    )
  }

  async unexpose(actionId: string): Promise<void> {
    if (!this.isExposed(actionId)) return
    await this.save(this.entries.filter((e) => e.actionId !== actionId))
    this.ports.logger.info(
      'export-google: unexposed action scene — removed on the next Google SYNC',
      {
        tags: { actionId },
      },
    )
  }

  /**
   * Drop what the operator deleted. An action list that could not be read
   * changes nothing (D49).
   */
  async reconcile(): Promise<void> {
    if (this.entries.length === 0) return
    let live: ReadonlySet<string>
    try {
      const actions = await this.ports.api.actions.list.query({})
      live = new Set(actions.map((a) => a.id))
    } catch (err) {
      this.ports.logger.warn('export-google: action scenes not reconciled — list unanswered', {
        meta: { error: errMsg(err) },
      })
      return
    }
    const { dropped } = pruneDeletedEntities(
      this.entries.map((e) => ({
        kind: 'action' as const,
        actionId: e.actionId,
      })),
      { actionIds: live, targetIds: new Set() },
      this.ports.logger,
      EXPORTER,
    )
    if (dropped.length === 0) return
    const gone = new Set(dropped.flatMap((r) => (r.kind === 'action' ? [r.actionId] : [])))
    await this.save(this.entries.filter((e) => !gone.has(e.actionId)))
  }

  /** The action a request addresses, or null (logged) when this link may not see it. */
  private async visibleAction(
    rawId: string,
    userId: string,
    intent: 'query' | 'execute',
  ): Promise<string | null> {
    const actionId = parseActionSceneId(rawId)
    if (actionId === null) return null
    if (!this.isExposed(actionId) || !(await this.admin(userId))) {
      this.ports.logger.warn(`google ${intent}: action scene refused — not visible to this link`, {
        tags: { actionId },
      })
      return null
    }
    return actionId
  }

  private async admin(userId: string): Promise<boolean> {
    try {
      return await this.ports.isAdminUser(userId)
    } catch (err) {
      this.ports.logger.warn('export-google: admin check failed — scenes hidden', {
        meta: { userId, error: errMsg(err) },
      })
      return false
    }
  }

  private async save(next: readonly ActionSceneEntry[]): Promise<void> {
    this.entries = next
    await this.ports.persist(next)
  }
}
