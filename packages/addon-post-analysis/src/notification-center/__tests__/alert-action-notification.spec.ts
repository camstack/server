/**
 * "An alert notification carries the alert's own action."
 *
 * Chain: an `alert.episode` bus event (raised) → intake → durable outbox →
 * drain → `mintButtons` → what LEAVES the process. The tap goes through the
 * real `NcActionPlane`.
 *
 *  - `href` → an ABSOLUTE open-URL action on the public endpoint;
 *  - `invoke` → a token-authed background button that runs exactly the frozen
 *    `{addonId, action, input}`, once;
 *  - a target with no buttons → the link becomes the tap (`clickUrl`);
 *  - the rule can switch it off; a resolved edge has none.
 */

import type { ServerResponse } from 'node:http'
import {
  alertEpisodePayload,
  EventCategory,
  NcRuleInputSchema,
  type Alert,
  type SystemEvent,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcActionPlane } from '../action-plane.js'
import { buildActionUrl } from '../action-token.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const BASE = 'https://camstack.example.top'
const ROUTE_PREFIX = '/addon/pipeline-analytics/nc-action'
const SECRET = 'per-install-secret'
const NOW = Date.now()

interface InvokeCall {
  readonly addonId: string
  readonly action: string
  readonly input?: Readonly<Record<string, unknown>>
}

interface HarnessOptions {
  readonly maxActions?: number
  readonly offerAlertAction?: boolean
  readonly baseUrl?: string | null
  readonly clickUrl?: string
}

const centers: NotificationCenter[] = []

function fakeRes(): { res: ServerResponse; body: () => string } {
  let body = ''
  const res = {
    writeHead: () => undefined,
    end: (chunk: string) => {
      body = chunk
    },
  }
  return { res: res as unknown as ServerResponse, body: () => body }
}

const alertOf = (action: Alert['action'], over: Partial<Alert> = {}): Alert => ({
  id: 'google:broker:b1',
  category: 'google.broker',
  severity: 'critical',
  title: 'Google sign-in expired',
  message: 'The Google account needs a new sign-in',
  status: 'active',
  read: false,
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  source: { type: 'addon', id: 'google-services' },
  metadata: { episodeId: 'google:broker:b1@1' },
  ...(action !== undefined ? { action } : {}),
  ...over,
})

function episodeEvent(alert: Alert, phase: 'raised' | 'resolved'): SystemEvent {
  return {
    id: `ep-${phase}-${String(Math.random())}`,
    timestamp: new Date(NOW),
    source: { type: 'addon', id: 'alert-center', nodeId: 'hub' },
    category: EventCategory.AlertEpisode,
    data: { ...alertEpisodePayload(alert, phase, NOW) },
  }
}

async function makeHarness(options: HarnessOptions = {}) {
  const world = makeNcRecords()
  const targets: readonly NcTargetRef[] = [
    {
      id: 'target-1',
      addonId: 'notifiers',
      name: 'phone',
      kind: 'zentik',
      enabled: true,
      ownerUserId: 'alice',
      ...(options.maxActions !== undefined ? { maxActions: options.maxActions } : {}),
    },
  ]
  const sends: NcSendInput[] = []
  const invoked: InvokeCall[] = []
  const baseUrl = options.baseUrl === undefined ? BASE : options.baseUrl
  let built: NotificationCenter | null = null
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      buildActions: (input) => built?.mintButtons(input) ?? Promise.resolve([]),
      publicUrlBase: async () => baseUrl,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    readNodeDirectory: async () => ({
      nodes: [{ id: 'hub', name: 'hub', isHub: true, isOnline: true }],
      complete: true,
    }),
    readRunnerStates: { coreBlocks: async () => [], nodeAddons: async () => [] },
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
    alertReconcileIntervalMs: 3_600_000,
    mintActionUrl: async ({ id, expMs }) =>
      baseUrl === null
        ? null
        : buildActionUrl({ baseUrl, routePrefix: ROUTE_PREFIX, id, secret: SECRET, expMs }),
    invokeAddonAction: async (call) => {
      invoked.push(call)
    },
  })
  built = center
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Alert',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['alert-critical', 'alert-critical-resolved'] } },
      systemEventDelivery: { mode: 'instant' },
      targets: [
        {
          targetId: 'target-1',
          ...(options.clickUrl !== undefined ? { params: { clickUrl: options.clickUrl } } : {}),
        },
      ],
      groupWithinSec: 0,
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      snoozeOptions: [],
      ...(options.offerAlertAction !== undefined
        ? { offerAlertAction: options.offerAlertAction }
        : {}),
    }),
  })
  const plane = new NcActionPlane({
    registry: center.actionTokenRegistry,
    secret: SECRET,
    logger: makeSilentLogger(),
    run: (grant) => center.runGrantedAction(grant),
  })
  return { center, sends, invoked, plane, rows: () => ncTable(world, 'outbox')?.size ?? 0 }
}
type Harness = Awaited<ReturnType<typeof makeHarness>>

async function deliver(h: Harness, event: SystemEvent): Promise<void> {
  const before = h.sends.length
  const rowsBefore = h.rows()
  h.center.onSystemEvent(event)
  await vi.waitFor(() => {
    expect(h.rows()).toBeGreaterThan(rowsBefore)
  })
  await h.center.drainNow()
  await vi.waitFor(() => {
    expect(h.sends.length).toBeGreaterThan(before)
  })
}

const lastActions = (h: Harness) => h.sends.at(-1)?.notification.actions ?? []

async function tap(h: Harness, url: string): Promise<string> {
  const { res, body } = fakeRes()
  await h.plane.handler({ url: url.slice(BASE.length), method: 'POST' } as never, res)
  return body()
}

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

const HREF_ACTION = {
  label: 'Sign in again',
  href: '/addon/google-services/oauth/start?brokerId=b1',
  navigation: 'server' as const,
}
const INVOKE_ACTION = {
  label: 'Reconnect',
  invoke: { addonId: 'google-services', action: 'reconnect', input: { brokerId: 'b1' } },
}

describe('an alert href becomes an absolute open-URL action', () => {
  it('a server route is the hub origin plus the route', async () => {
    const h = await makeHarness()
    await deliver(h, episodeEvent(alertOf(HREF_ACTION), 'raised'))
    const open = lastActions(h).find((a) => a.id === 'alert-open')
    expect(open?.label).toBe('Sign in again')
    expect(open?.url).toBe(`${BASE}/addon/google-services/oauth/start?brokerId=b1`)
    expect(open?.mode).toBe('navigate')
  })

  it('an admin-ui route (navigation app) lands under the same origin', async () => {
    const h = await makeHarness()
    await deliver(
      h,
      episodeEvent(
        alertOf({ label: 'Open', href: '/system/storage', navigation: 'app' }),
        'raised',
      ),
    )
    expect(lastActions(h).find((a) => a.id === 'alert-open')?.url).toBe(`${BASE}/system/storage`)
  })

  it('carries no action when no public address is reachable', async () => {
    const h = await makeHarness({ baseUrl: null })
    await deliver(h, episodeEvent(alertOf(HREF_ACTION), 'raised'))
    expect(lastActions(h).find((a) => a.id === 'alert-open')).toBeUndefined()
  })
})

describe('an alert invoke becomes a token-authed background button', () => {
  it('a tap runs exactly the frozen invoke, once', async () => {
    const h = await makeHarness()
    await deliver(h, episodeEvent(alertOf(INVOKE_ACTION), 'raised'))
    const button = lastActions(h).find((a) => a.id === 'alert-invoke')
    expect(button?.mode).toBe('background')
    expect(button?.url).toMatch(
      new RegExp(`^${BASE}${ROUTE_PREFIX}/[^?]+\\?exp=\\d+&sig=[0-9a-f]{64}$`),
    )

    const answer = await tap(h, button?.url ?? '')
    expect(answer).toContain('Done')
    expect(h.invoked).toEqual([
      { addonId: 'google-services', action: 'reconnect', input: { brokerId: 'b1' } },
    ])
    // Spent: a second tap runs nothing.
    await tap(h, button?.url ?? '')
    expect(h.invoked).toHaveLength(1)
  })

  it('a forged signature runs nothing', async () => {
    const h = await makeHarness()
    await deliver(h, episodeEvent(alertOf(INVOKE_ACTION), 'raised'))
    const url = lastActions(h).find((a) => a.id === 'alert-invoke')?.url ?? ''
    await tap(h, url.replace(/sig=[0-9a-f]{64}/, `sig=${'0'.repeat(64)}`))
    expect(h.invoked).toEqual([])
  })
})

describe('where the action is not offered', () => {
  it('a target with no buttons taps into the link instead', async () => {
    const h = await makeHarness({ maxActions: 0 })
    await deliver(h, episodeEvent(alertOf(HREF_ACTION), 'raised'))
    const sent = h.sends.at(-1)?.notification
    expect(sent?.clickUrl).toBe(`${BASE}/addon/google-services/oauth/start?brokerId=b1`)
    expect(sent?.actions ?? []).toHaveLength(0)
  })

  it('a rule-authored clickUrl still wins on a target with no buttons', async () => {
    const h = await makeHarness({ maxActions: 0, clickUrl: 'https://example.test/mine' })
    await deliver(h, episodeEvent(alertOf(HREF_ACTION), 'raised'))
    expect(h.sends.at(-1)?.notification.clickUrl).toBe('https://example.test/mine')
  })

  it('a rule that switched it off carries nothing', async () => {
    const h = await makeHarness({ offerAlertAction: false })
    await deliver(h, episodeEvent(alertOf({ ...HREF_ACTION, ...INVOKE_ACTION }), 'raised'))
    const ids = lastActions(h).map((a) => a.id)
    expect(ids).not.toContain('alert-open')
    expect(ids).not.toContain('alert-invoke')
  })

  it('a resolved edge carries no action', async () => {
    const h = await makeHarness()
    const alert = alertOf(HREF_ACTION)
    await deliver(h, episodeEvent(alert, 'raised'))
    expect(lastActions(h).map((a) => a.id)).toContain('alert-open')
    await deliver(h, episodeEvent({ ...alert, status: 'completed' }, 'resolved'))
    const ids = lastActions(h).map((a) => a.id)
    expect(ids).not.toContain('alert-open')
    expect(ids).not.toContain('alert-invoke')
  })
})
