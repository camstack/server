/**
 * An exported ACTION is an Alexa scene (D968): `Alexa.SceneController`,
 * Activate → `actions.run`. Actions are list entries, not devices (D954), so
 * the endpoint is not under a device id and only an ADMIN link may see or
 * fire it (`actions.run` is an admin act; a scoped user reaches an action only
 * through a camera that links it, which a scene cannot express).
 */
import type { ActionRunResult, ExportEntityApi, IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import type { AlexaPrincipal } from '../access/access-gate.js'
import {
  actionEndpointId,
  ActionSceneExports,
  type ActionSceneEntry,
  type ActionScenePorts,
  buildActionSceneEndpoint,
  handleActionSceneDirective,
  parseActionEndpointId,
} from '../action-scenes.js'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'

interface Line {
  readonly level: string
  readonly message: string
  readonly extras: LogExtras | undefined
}

function makeLogger(lines: Line[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message, extras) => void lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => void lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => void lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const ADMIN: AlexaPrincipal = { kind: 'admin', userId: 'u-admin' }
const SCOPED: AlexaPrincipal = { kind: 'scoped', userId: 'u-viewer', scopes: [] }
const HEADER = {
  namespace: 'Alexa.SceneController',
  name: 'Activate',
  payloadVersion: '3',
  messageId: 'm1',
  correlationToken: 'c1',
}

function makeApi(
  run: (input: { actionId: string }) => Promise<ActionRunResult>,
  actions: { id: string; name: string }[] = [{ id: 'internal:a', name: 'Open gate' }],
): ExportEntityApi {
  return {
    actions: { list: { query: async () => actions }, run: { mutate: run } },
    notificationOutput: {
      listTargets: { query: async () => [] },
      send: { mutate: async () => ({ success: true }) },
    },
  }
}

describe('scene endpoint', () => {
  it('is a valid Alexa scene endpoint, outside the device id space', () => {
    const endpoint = buildActionSceneEndpoint({
      actionId: 'internal:3f2a',
      displayName: 'Open gate',
      addedAt: 1,
    })
    expect(endpoint.endpointId).toBe(actionEndpointId('internal:3f2a'))
    expect(endpoint.displayCategories).toEqual(['SCENE_TRIGGER'])
    expect(endpoint.friendlyName).toBe('Open gate')
    const scene = endpoint.capabilities.find((c) => c.interface === 'Alexa.SceneController')
    expect(scene).toMatchObject({ version: '3', supportsDeactivation: false })
    expect(validateAlexaEndpoint(endpoint)).toEqual([])
    expect(parseActionEndpointId(endpoint.endpointId)).toBe('internal:3f2a')
    // never mistaken for a device endpoint
    expect(parseCameraEndpointId(endpoint.endpointId).kind).toBe('invalid')
    expect(parseActionEndpointId('101')).toBeNull()
    expect(parseActionEndpointId('101__dev')).toBeNull()
  })
})

describe('handleActionSceneDirective', () => {
  function ctx(run: (input: { actionId: string }) => Promise<ActionRunResult>, lines: Line[] = []) {
    return {
      api: makeApi(run),
      logger: makeLogger(lines),
      isExposed: (actionId: string) => actionId === 'internal:a',
    }
  }
  const endpoint = { endpointId: actionEndpointId('internal:a') }

  it('Activate runs the action and answers ActivationStarted', async () => {
    const run = vi.fn(async () => ({ runId: 'r', outcome: 'started' as const }))
    const body = await handleActionSceneDirective(HEADER, endpoint, ADMIN, ctx(run))
    expect(run).toHaveBeenCalledWith({ actionId: 'internal:a' })
    expect(body).toMatchObject({
      event: {
        header: {
          namespace: 'Alexa.SceneController',
          name: 'ActivationStarted',
          correlationToken: 'c1',
        },
        endpoint: { endpointId: endpoint.endpointId },
        payload: { cause: { type: 'VOICE_INTERACTION' } },
      },
    })
  })

  it('an action that is already running answers ENDPOINT_BUSY and is logged, never queued', async () => {
    const lines: Line[] = []
    const run = vi.fn(
      async (): Promise<ActionRunResult> => ({
        runId: 'r',
        outcome: 'skipped-overlap',
      }),
    )
    const body = await handleActionSceneDirective(HEADER, endpoint, ADMIN, ctx(run, lines))
    expect(run).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({ event: { payload: { type: 'ENDPOINT_BUSY' } } })
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('already-running'))).toBe(
      true,
    )
  })

  it('a scoped link, an unexposed action and a foreign directive never reach actions.run', async () => {
    const run = vi.fn(async () => ({ runId: 'r', outcome: 'started' as const }))
    const scoped = await handleActionSceneDirective(HEADER, endpoint, SCOPED, ctx(run))
    expect(scoped).toMatchObject({ event: { payload: { type: 'NO_SUCH_ENDPOINT' } } })
    const unexposed = await handleActionSceneDirective(
      HEADER,
      { endpointId: actionEndpointId('internal:zzz') },
      ADMIN,
      ctx(run),
    )
    expect(unexposed).toMatchObject({ event: { payload: { type: 'NO_SUCH_ENDPOINT' } } })
    const other = await handleActionSceneDirective(
      { ...HEADER, namespace: 'Alexa.PowerController', name: 'TurnOn' },
      endpoint,
      ADMIN,
      ctx(run),
    )
    expect(other).toMatchObject({ event: { payload: { type: 'INVALID_DIRECTIVE' } } })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('ActionSceneExports', () => {
  function build(initial: readonly ActionSceneEntry[], actions?: { id: string; name: string }[]) {
    const lines: Line[] = []
    const added: Array<{ userId: string; ids: string[] }> = []
    const deleted: Array<{ userId: string; ids: string[] }> = []
    const persisted: ActionSceneEntry[][] = []
    const ports: ActionScenePorts = {
      api: makeApi(async () => ({ runId: 'r', outcome: 'started' }), actions),
      logger: makeLogger(lines),
      linkedUserIds: () => ['u-admin', 'u-viewer'],
      isAdminUser: async (userId) => userId === 'u-admin',
      canPush: () => true,
      postAddOrUpdate: async (userId, endpoints) => {
        added.push({ userId, ids: endpoints.map((e) => e.endpointId) })
        return true
      },
      postDelete: async (userId, ids) => {
        deleted.push({ userId, ids: [...ids] })
        return true
      },
      persist: async (entries) => void persisted.push([...entries]),
    }
    return { exports: new ActionSceneExports(ports, initial), added, deleted, persisted, lines }
  }

  it('expose persists and pushes the scene to ADMIN accounts only', async () => {
    const h = build([])
    await h.exports.expose('internal:a')
    expect(h.persisted.at(-1)).toEqual([
      expect.objectContaining({ actionId: 'internal:a', displayName: 'Open gate' }),
    ])
    expect(h.added).toEqual([{ userId: 'u-admin', ids: [actionEndpointId('internal:a')] }])
    expect(h.exports.isExposed('internal:a')).toBe(true)
    expect(h.exports.list()).toEqual([
      { entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' },
    ])
  })

  it('refuses to expose an action that does not exist', async () => {
    const h = build([])
    await expect(h.exports.expose('internal:nope')).rejects.toThrow(/internal:nope/)
    expect(h.persisted).toHaveLength(0)
  })

  it('unexpose deletes the scene from Alexa and persists', async () => {
    const h = build([{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }])
    await h.exports.unexpose('internal:a')
    expect(h.deleted.map((d) => d.userId)).toEqual(['u-admin', 'u-viewer'])
    expect(h.deleted[0]?.ids).toEqual([actionEndpointId('internal:a')])
    expect(h.persisted.at(-1)).toEqual([])
  })

  it('reconcile drops a deleted action, deletes its scene and logs the drop', async () => {
    const h = build([
      { actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 },
      { actionId: 'internal:gone', displayName: 'Old', addedAt: 2 },
    ])
    await h.exports.reconcile()
    expect(h.persisted.at(-1)?.map((e) => e.actionId)).toEqual(['internal:a'])
    expect(h.deleted[0]?.ids).toEqual([actionEndpointId('internal:gone')])
    expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('deleted'))).toBe(true)
  })

  it('discovery lists the scenes for an admin and nothing for a scoped user', async () => {
    const h = build([{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }])
    expect(h.exports.endpointsFor(ADMIN).map((e) => e.endpointId)).toEqual([
      actionEndpointId('internal:a'),
    ])
    expect(h.exports.endpointsFor(SCOPED)).toEqual([])
  })
})
