/**
 * An exported action through the directive router (D968): Discovery adds the
 * scene for an ADMIN link only, and Activate reaches `actions.run` only for an
 * admin link and an exported action.
 */
import type {
  ActionRunResult,
  AddonContext,
  ExportEntityApi,
  IScopedLogger,
  TokenScope,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AlexaAccessGate, type AlexaUserGrant } from '../access/access-gate.js'
import { ActionSceneExports, actionEndpointId } from '../action-scenes.js'
import {
  type DirectiveRouterDeps,
  dispatchDirective,
  type VerifiedDirectiveIdentity,
} from '../directive-router.js'
import type { AlexaEndpoint } from '../endpoints/types.js'
import { snapshotsOff, visionOff } from './helpers/allow-all-access.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withTags: () => logger,
  child: () => logger,
}

const USERS: readonly AlexaUserGrant[] = [
  { userId: 'admin', isAdmin: true, scopes: [] },
  { userId: 'viewer', isAdmin: false, scopes: [] },
]
const LINK_SCOPES: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]
const identity = (userId: string): VerifiedDirectiveIdentity => ({
  userId,
  username: userId,
  scopes: LINK_SCOPES,
})

function setup() {
  const run = vi.fn(
    async (_input: { actionId: string }): Promise<ActionRunResult> => ({
      runId: 'r',
      outcome: 'started',
    }),
  )
  const api: ExportEntityApi = {
    actions: {
      list: { query: async () => [{ id: 'internal:a', name: 'Open gate' }] },
      run: { mutate: run },
    },
    notificationOutput: {
      listTargets: { query: async () => [] },
      send: { mutate: async () => ({ success: true }) },
    },
  }
  const exports = new ActionSceneExports(
    {
      api,
      logger,
      linkedUserIds: () => [],
      isAdminUser: async () => true,
      canPush: () => false,
      postAddOrUpdate: async () => true,
      postDelete: async () => true,
      persist: async () => undefined,
    },
    [{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }],
  )
  const ctx = {} as Partial<AddonContext> as AddonContext
  const gate = new AlexaAccessGate({
    listUserGrants: async () => USERS,
    getDeviceMeta: async () => null,
    logger,
  })
  const deps: DirectiveRouterDeps = {
    discovery: { ctx, logger, listExposed: async () => [], buildEndpoints: async () => [] },
    cameraStream: { ctx, logger, listExposed: () => [] },
    rtcSession: { ctx, logger, listExposed: () => [] },
    ptzPreset: { ctx, logger },
    powerController: { ctx, logger },
    brightnessController: { ctx, logger },
    ptzDirection: { ctx, logger },
    reportState: { ctx, logger },
    securityPanel: { ctx, logger },
    snapshotProvider: snapshotsOff().provider,
    vision: visionOff(),
    lockController: { ctx, logger },
    coverController: { ctx, logger, sendAsyncResponse: async () => true },
    climateController: { ctx, logger },
    access: { gate, isExposed: () => false },
    afterDiscovery: () => {},
    actionScenes: { exports, api, logger },
  }
  return { deps, run }
}

const discover = {
  directive: {
    header: {
      namespace: 'Alexa.Discovery',
      name: 'Discover',
      messageId: 'm1',
      payloadVersion: '3',
    },
    payload: { scope: { type: 'BearerToken', token: 't' } },
  },
}
const activate = (endpointId: string): unknown => ({
  directive: {
    header: {
      namespace: 'Alexa.SceneController',
      name: 'Activate',
      messageId: 'm2',
      correlationToken: 'c2',
      payloadVersion: '3',
    },
    endpoint: { endpointId, scope: { type: 'BearerToken', token: 't' } },
    payload: {},
  },
})
const nameOf = (body: unknown): string | undefined =>
  (body as { event?: { header?: { name?: string } } }).event?.header?.name
const typeOf = (body: unknown): string | undefined =>
  (body as { event?: { payload?: { type?: string } } }).event?.payload?.type
const endpointsOf = (body: unknown): readonly AlexaEndpoint[] =>
  (body as { event: { payload: { endpoints: AlexaEndpoint[] } } }).event.payload.endpoints

describe('exported action through the router', () => {
  it('Discovery lists the scene for an admin link', async () => {
    const { deps } = setup()
    const r = await dispatchDirective(discover, deps, identity('admin'))
    expect(endpointsOf(r.body).map((e) => e.endpointId)).toEqual([actionEndpointId('internal:a')])
  })

  it('Discovery does not list it for a scoped link', async () => {
    const { deps } = setup()
    const r = await dispatchDirective(discover, deps, identity('viewer'))
    expect(endpointsOf(r.body)).toEqual([])
  })

  it('Activate from an admin link runs the action', async () => {
    const { deps, run } = setup()
    const r = await dispatchDirective(
      activate(actionEndpointId('internal:a')),
      deps,
      identity('admin'),
    )
    expect(nameOf(r.body)).toBe('ActivationStarted')
    expect(run).toHaveBeenCalledWith({ actionId: 'internal:a' })
  })

  it('Activate from a scoped link never runs it', async () => {
    const { deps, run } = setup()
    const r = await dispatchDirective(
      activate(actionEndpointId('internal:a')),
      deps,
      identity('viewer'),
    )
    expect(typeOf(r.body)).toBe('NO_SUCH_ENDPOINT')
    expect(run).not.toHaveBeenCalled()
  })
})
