/**
 * Actions exported to Alexa as SCENES (D968).
 *
 * Alexa has no "run" verb for an arbitrary automation, but it has a scene: an
 * endpoint with `Alexa.SceneController` whose Activate directive fires
 * something. An action is exactly that, so it is exported as a scene trigger
 * and Activate runs `actions.run`.
 *
 * An action is a list entry, never a device (D954), so its endpoint id lives
 * outside the numeric device id space (`action:<id>`, which the device id
 * parser rejects) and nothing here touches the device registry or the
 * per-device sync engine.
 *
 * `actions.run` is an admin act, so only an ADMIN link sees or fires a scene.
 * A scoped (non-admin) link is told the endpoint does not exist.
 *
 * Whether the run is accepted is decided by `actions.run`: an action that is
 * already running or in cooldown is refused with a named reason (logged by
 * `runExportedAction`) and answered `ENDPOINT_BUSY` — never queued.
 */
import {
  type ExportEntityApi,
  type ExposedEntity,
  type IScopedLogger,
  pruneDeletedEntities,
  runExportedAction,
} from '@camstack/types'

import type { AlexaPrincipal } from './access/access-gate.js'
import type { AlexaEndpoint } from './endpoints/types.js'
import { errorEnvelope } from './handlers/error-envelope.js'
import type { DirectiveHeader } from './handlers/types.js'

const EXPORTER = 'export-alexa'
const PREFIX = 'action:'
const SCENE_INTERFACE = 'Alexa.SceneController'

/** One persisted selection row, in the addon's own settings. */
export interface ActionSceneEntry {
  readonly actionId: string
  readonly displayName: string
  readonly addedAt: number
}

export function actionEndpointId(actionId: string): string {
  return `${PREFIX}${actionId}`
}

/** The action id an endpoint id names, or null when it is not an action endpoint. */
export function parseActionEndpointId(endpointId: string): string | null {
  if (!endpointId.startsWith(PREFIX)) return null
  const id = endpointId.slice(PREFIX.length)
  return id.length === 0 ? null : id
}

export function buildActionSceneEndpoint(entry: ActionSceneEntry): AlexaEndpoint {
  return {
    endpointId: actionEndpointId(entry.actionId),
    manufacturerName: 'CamStack',
    description: 'CamStack action',
    friendlyName: entry.displayName,
    displayCategories: ['SCENE_TRIGGER'],
    capabilities: [
      { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
      {
        type: 'AlexaInterface',
        interface: SCENE_INTERFACE,
        version: '3',
        supportsDeactivation: false,
        proactivelyReported: false,
      },
    ],
  }
}

export interface ActionSceneDirectiveContext {
  readonly api: ExportEntityApi
  readonly logger: IScopedLogger
  readonly isExposed: (actionId: string) => boolean
}

function sceneResponse(header: DirectiveHeader, endpointId: string): unknown {
  return {
    event: {
      header: {
        namespace: SCENE_INTERFACE,
        name: 'ActivationStarted',
        messageId: header.messageId,
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      endpoint: { endpointId },
      payload: {
        cause: { type: 'VOICE_INTERACTION' },
        timestamp: new Date().toISOString(),
      },
    },
  }
}

/** Answer a directive addressed to an action endpoint. */
export async function handleActionSceneDirective(
  header: DirectiveHeader,
  endpoint: { readonly endpointId: string },
  principal: AlexaPrincipal,
  deps: ActionSceneDirectiveContext,
): Promise<unknown> {
  const actionId = parseActionEndpointId(endpoint.endpointId)
  if (actionId === null) return errorEnvelope(header, 'NO_SUCH_ENDPOINT', 'not an action endpoint')
  // Fail closed: a non-admin link, or an action that is not exported, does not see it.
  if (principal.kind !== 'admin' || !deps.isExposed(actionId)) {
    deps.logger.warn('alexa action-scene: directive refused — endpoint not visible to this link', {
      tags: { actionId },
      meta: { reason: principal.kind !== 'admin' ? 'not-admin' : 'not-exported' },
    })
    return errorEnvelope(header, 'NO_SUCH_ENDPOINT', 'unknown endpoint')
  }
  if (header.namespace !== SCENE_INTERFACE || header.name !== 'Activate') {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'an action endpoint only supports Activate')
  }
  const result = await runExportedAction(deps.api, deps.logger, {
    exporter: EXPORTER,
    actionId,
  })
  switch (result.status) {
    case 'started':
      return sceneResponse(header, endpoint.endpointId)
    case 'refused':
      return result.reason === 'not-found'
        ? errorEnvelope(header, 'NO_SUCH_ENDPOINT', 'the action no longer exists')
        : errorEnvelope(header, 'ENDPOINT_BUSY', `the action cannot run now (${result.reason})`)
    case 'failed':
      return errorEnvelope(header, 'ENDPOINT_UNREACHABLE', result.message)
  }
}

export interface ActionScenePorts {
  readonly api: ExportEntityApi
  readonly logger: IScopedLogger
  /** Every linked Alexa account. */
  readonly linkedUserIds: () => readonly string[]
  readonly isAdminUser: (userId: string) => Promise<boolean>
  /** False when the event gateway is not usable (no link, no token). */
  readonly canPush: () => boolean
  readonly postAddOrUpdate: (
    userId: string,
    endpoints: readonly AlexaEndpoint[],
  ) => Promise<boolean>
  readonly postDelete: (userId: string, endpointIds: readonly string[]) => Promise<boolean>
  readonly persist: (entries: readonly ActionSceneEntry[]) => Promise<void>
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

  /** The scenes Discovery adds for this link: admins only. */
  endpointsFor(principal: AlexaPrincipal): readonly AlexaEndpoint[] {
    if (principal.kind !== 'admin') return []
    return this.entries.map(buildActionSceneEndpoint)
  }

  async expose(actionId: string): Promise<void> {
    const actions = await this.ports.api.actions.list.query({})
    const action = actions.find((a) => a.id === actionId)
    if (action === undefined) {
      throw new Error(`export-alexa: action '${actionId}' does not exist`)
    }
    const entry: ActionSceneEntry = {
      actionId,
      displayName: action.name,
      addedAt: this.entries.find((e) => e.actionId === actionId)?.addedAt ?? Date.now(),
    }
    await this.save([...this.entries.filter((e) => e.actionId !== actionId), entry])
    await this.pushToAdmins([buildActionSceneEndpoint(entry)])
    this.ports.logger.info('export-alexa: exposed action as a scene', {
      tags: { actionId },
      meta: { displayName: action.name },
    })
  }

  async unexpose(actionId: string): Promise<void> {
    if (this.isExposed(actionId))
      await this.save(this.entries.filter((e) => e.actionId !== actionId))
    await this.deleteFromAll([actionEndpointId(actionId)])
    this.ports.logger.info('export-alexa: unexposed action scene', { tags: { actionId } })
  }

  /** Push every scene (boot, relink). */
  async pushAll(): Promise<void> {
    await this.pushToAdmins(this.entries.map(buildActionSceneEndpoint))
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
      this.ports.logger.warn('export-alexa: action scenes not reconciled — list unanswered', {
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
    const gone = new Set(dropped.flatMap((r) => (r.kind === 'action' ? [r.actionId] : [])))
    await this.save(this.entries.filter((e) => !gone.has(e.actionId)))
    await this.deleteFromAll([...gone].map(actionEndpointId))
  }

  private async save(next: readonly ActionSceneEntry[]): Promise<void> {
    this.entries = next
    await this.ports.persist(next)
  }

  private async pushToAdmins(endpoints: readonly AlexaEndpoint[]): Promise<void> {
    if (endpoints.length === 0 || !this.ports.canPush()) return
    for (const userId of this.ports.linkedUserIds()) {
      try {
        if (!(await this.ports.isAdminUser(userId))) continue
        await this.ports.postAddOrUpdate(userId, endpoints)
      } catch (err) {
        this.ports.logger.warn('export-alexa: action scene push failed', {
          meta: { userId, error: errMsg(err) },
        })
      }
    }
  }

  private async deleteFromAll(ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || !this.ports.canPush()) return
    for (const userId of this.ports.linkedUserIds()) {
      try {
        await this.ports.postDelete(userId, ids)
      } catch (err) {
        this.ports.logger.warn('export-alexa: action scene delete failed', {
          meta: { userId, error: errMsg(err) },
        })
      }
    }
  }
}
