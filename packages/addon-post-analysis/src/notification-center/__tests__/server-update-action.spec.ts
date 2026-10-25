/**
 * "Tap to apply the server update this notification is about."
 *
 * Same chain as addon-update-action.spec.ts: a raw `update.available` with
 * `target: 'server'` → intake → durable outbox → drain → the minted button →
 * the real `NcActionPlane` handler. Asserted on what LEAVES the process.
 *
 * D324 deliberately minted no button for this kind (a node reboot). D325
 * reverses that for the named node, on the same terms: freeze WHERE, never a
 * version, ask the authority what is still true before acting. The outcome
 * of the reboot itself is the existing `server-updated` event — this button
 * only stages and says it has.
 */

import type { ServerResponse } from 'node:http'
import { createEvent, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcActionPlane } from '../action-plane.js'
import { ncPruneWindowsPort, makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { buildActionUrl } from '../action-token.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const BASE = 'https://camstack.example.top'
const ROUTE_PREFIX = '/addon/pipeline-analytics/nc-action'
const SECRET = 'per-install-secret'

interface Harness {
  readonly center: NotificationCenter
  readonly rows: () => number
  readonly sends: NcSendInput[]
  readonly applied: string[]
  readonly plane: NcActionPlane
  readonly available: { value: boolean | 'throw' | 'refused' }
}

interface HarnessOptions {
  readonly baseUrl?: string | null
  readonly available?: boolean | 'throw' | 'refused'
  readonly unowned?: boolean
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

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const world = makeNcRecords()
  const targets: readonly NcTargetRef[] = [
    {
      id: 'target-1',
      addonId: 'notifiers',
      name: 'phone',
      kind: 'zentik',
      enabled: true,
      ...(options.unowned === true ? {} : { ownerUserId: 'alice' }),
    },
  ]
  const sends: NcSendInput[] = []
  const applied: string[] = []
  const available: { value: boolean | 'throw' | 'refused' } = {
    value: options.available ?? true,
  }
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
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
    mintActionUrl: async ({ id, expMs }) =>
      baseUrl === null
        ? null
        : buildActionUrl({ baseUrl, routePrefix: ROUTE_PREFIX, id, secret: SECRET, expMs }),
    listAddonUpdates: async () => [],
    applyAddonUpdate: async () => ({ ok: true as const }),
    checkServerUpdate: async () => {
      if (available.value === 'throw') throw new Error('registry unreachable')
      // 'refused' still looks available — the apply seam is what refuses.
      return available.value !== false
    },
    applyServerUpdate: async (input) => {
      if (available.value === 'refused') {
        return { ok: false as const, error: 'staging refused' }
      }
      applied.push(input.nodeId)
      return { ok: true as const }
    },
  })
  built = center
  centers.push(center)
  await center.start({ evaluation: true })
  await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Aggiornamenti',
      delivery: 'system-event',
      conditions: {
        systemEvent: { kinds: ['addon-update-available', 'server-update-available'] },
      },
      targets: [{ targetId: 'target-1' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule' },
      snoozeOptions: [],
    }),
  })

  const plane = new NcActionPlane({
    registry: center.actionTokenRegistry,
    secret: SECRET,
    logger: makeSilentLogger(),
    run: (grant) => center.runGrantedAction(grant),
  })

  return {
    center,
    rows: () => ncTable(world, 'outbox')?.size ?? 0,
    sends,
    applied,
    plane,
    available,
  }
}

function serverAvailable(node: string) {
  return createEvent(
    'update.available',
    { type: 'core', id: 'updates' },
    {
      target: 'server',
      packageName: '@camstack/server',
      currentVersion: '1.2.190',
      latestVersion: '1.2.198',
      packages: [
        {
          packageName: '@camstack/server',
          currentVersion: '1.2.190',
          latestVersion: '1.2.198',
          nodeId: node,
        },
      ],
      nodeId: node,
    },
  )
}

async function deliver(h: Harness, event: ReturnType<typeof serverAvailable>): Promise<void> {
  h.center.onSystemEvent(event)
  await vi.waitFor(() => {
    expect(h.rows()).toBeGreaterThan(0)
  })
  await h.center.drainNow()
}

function serverButton(sends: readonly NcSendInput[]) {
  const actions = sends.at(-1)?.notification.actions ?? []
  return actions.find((action) => action.id === 'server-update-apply')
}

async function tap(h: Harness, url: string): Promise<string> {
  const { res, body } = fakeRes()
  await h.plane.handler({ url: url.slice(BASE.length), method: 'POST' } as never, res)
  return body()
}

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

describe('a server-update notification carries a button that stages it on the named node', () => {
  it('names the node, and is a background call', async () => {
    const h = await makeHarness()
    await deliver(h, serverAvailable('agent-a'))

    const button = serverButton(h.sends)
    expect(button?.label).toBe('Update server on agent-a')
    expect(button?.mode).toBe('background')
    expect(button?.destructive).toBe(true)
    expect(button?.icon).toBeUndefined()
    expect(button?.url).toMatch(
      new RegExp(`^${BASE}${ROUTE_PREFIX}/[^?]+\\?exp=\\d+&sig=[0-9a-f]{64}$`),
    )
  })

  it('applies on the node the row named, and never restates a version', async () => {
    const h = await makeHarness()
    await deliver(h, serverAvailable('agent-a'))
    const before = h.sends.length
    await tap(h, serverButton(h.sends)!.url!)

    expect(h.applied).toEqual(['agent-a'])
    const said = h.sends
      .slice(before)
      .map((send) => `${send.notification.title} ${send.notification.body}`)
      .join(' ')
    expect(said).not.toContain('1.2.198')
    expect(said).not.toContain('1.2.190')
    expect(said).not.toContain('latest')
  })

  it('tells the operator it started, then that the node is restarting', async () => {
    const h = await makeHarness()
    await deliver(h, serverAvailable('hub'))
    const before = h.sends.length
    await tap(h, serverButton(h.sends)!.url!)

    expect(h.sends.slice(before).map((send) => send.notification.body)).toEqual([
      'Updating server on hub…',
      'Server update staged on hub — the node is restarting. You will hear when it comes back.',
    ])
    expect(h.sends.slice(before).every((send) => send.targetId === 'target-1')).toBe(true)
  })

  it('asks whether an update is STILL available and does not apply when it is not', async () => {
    const h = await makeHarness({ available: false })
    await deliver(h, serverAvailable('hub'))
    const before = h.sends.length
    await tap(h, serverButton(h.sends)!.url!)

    expect(h.applied).toEqual([])
    expect(h.sends.slice(before).map((send) => send.notification.body)).toEqual([
      'Already up to date on hub — nothing to do',
    ])
  })

  it('changes nothing when it cannot read whether an update is still needed', async () => {
    const h = await makeHarness({ available: 'throw' })
    await deliver(h, serverAvailable('hub'))
    const before = h.sends.length
    expect(await tap(h, serverButton(h.sends)!.url!)).toContain('did not work')
    expect(h.applied).toEqual([])
    expect(h.sends.slice(before).map((send) => send.notification.body)).toEqual([
      'Could not read whether hub still needs a server update — nothing was changed. Open CamStack.',
    ])
  })

  it('reports a refused apply as a failure, and does not claim a restart', async () => {
    const h = await makeHarness({ available: 'refused' })
    await deliver(h, serverAvailable('hub'))
    const before = h.sends.length
    expect(await tap(h, serverButton(h.sends)!.url!)).toContain('did not work')
    expect(h.applied).toEqual([])
    expect(h.sends.slice(before).map((send) => send.notification.body)).toEqual([
      'Updating server on hub…',
      'Server update on hub was refused — nothing was changed. Open CamStack.',
    ])
  })

  it('spends the button once', async () => {
    const h = await makeHarness()
    await deliver(h, serverAvailable('hub'))
    const url = serverButton(h.sends)!.url!
    expect(await tap(h, url)).toContain('Done')
    expect(h.applied).toHaveLength(1)
    expect(await tap(h, url)).toContain('Already done')
    expect(h.applied).toHaveLength(1)
  })
})

describe('what the server-update button REFUSES to be', () => {
  it('a row that spans several nodes gets no button — and still gets its notification', async () => {
    const h = await makeHarness()
    h.center.onSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'server',
          packageName: '@camstack/server',
          currentVersion: '1.2.190',
          latestVersion: '1.2.198',
          packages: [
            {
              packageName: '@camstack/server',
              currentVersion: '1.2.190',
              latestVersion: '1.2.198',
              nodeId: 'hub',
            },
            {
              packageName: '@camstack/server',
              currentVersion: '1.2.190',
              latestVersion: '1.2.198',
              nodeId: 'agent-a',
            },
          ],
        },
      ),
    )
    await vi.waitFor(() => {
      expect(h.rows()).toBeGreaterThan(0)
    })
    await h.center.drainNow()

    expect(h.sends).toHaveLength(1)
    expect(serverButton(h.sends)).toBeUndefined()
    expect(h.sends[0]?.notification.clickUrl).toContain('/system/nodes')
  })

  it('a destination nobody owns gets no button — it gets the Cluster page', async () => {
    const h = await makeHarness({ unowned: true })
    await deliver(h, serverAvailable('hub'))

    expect(h.sends).toHaveLength(1)
    expect(serverButton(h.sends)).toBeUndefined()
    expect(h.sends[0]?.notification.clickUrl).toContain('/system/nodes?node=hub')
  })

  it('a loopback-only install loses the button, never the notification', async () => {
    const h = await makeHarness({ baseUrl: null })
    await deliver(h, serverAvailable('hub'))

    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.actions ?? []).toEqual([])
  })
})
