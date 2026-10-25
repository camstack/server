/**
 * "Tap to apply the updates this notification is about."
 *
 * Everything here is asserted on what LEAVES the process — the
 * `notification-output.send` payload the dispatcher hands over, and the
 * `addons.updatePackage` seam the runner reaches through — never on an
 * intermediate the production code could have got right while writing the
 * wrong thing onto the wire.
 *
 * The chain each case walks is the real one: a RAW `update.available` bus
 * event → intake → the durable outbox row → a real drain → the minted button →
 * the real `NcActionPlane` handler over the minted URL. A test that hand-built
 * the subject could not have caught `mintActions` failing to hand the frozen
 * package list to the builder, which is the whole of this change.
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

/** One `addons.updatePackage` call, as it left this process. */
interface AppliedCall {
  readonly packageName: string
  readonly nodeId: string
}

interface Harness {
  readonly center: NotificationCenter
  readonly rows: () => number
  readonly sends: NcSendInput[]
  readonly applied: AppliedCall[]
  readonly plane: NcActionPlane
  readonly updatable: { value: readonly string[] | 'throw' }
  readonly failing: Set<string>
}

interface HarnessOptions {
  /** Null ⇒ a loopback-only install: no reachable base URL, so no buttons. */
  readonly baseUrl?: string | null
  /** What `addons.listUpdates` currently reports for the node. */
  readonly updatable?: readonly string[] | 'throw'
  /** Package names whose `updatePackage` fails. */
  readonly failing?: readonly string[]
  /** A shared destination nobody owns. */
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
  // The handler uses only writeHead/end. Documented type boundary — the same
  // one `action-plane.spec.ts` takes.
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
      // OWNED. The button refuses a destination nobody owns — see the last
      // case in this file.
      ...(options.unowned === true ? {} : { ownerUserId: 'alice' }),
    },
  ]
  const sends: NcSendInput[] = []
  const applied: AppliedCall[] = []
  const updatable: { value: readonly string[] | 'throw' } = {
    value: options.updatable ?? [],
  }
  const failing = new Set<string>(options.failing ?? [])
  const baseUrl = options.baseUrl === undefined ? BASE : options.baseUrl

  // Late-bound exactly as `pipeline-analytics/index.ts` binds it: the centre
  // does not wire its own button minter, the addon does
  // (`buildActions: (input) => this.notificationCenter?.mintButtons(input)`).
  // Reproducing that here is deliberate — a harness that called `mintButtons`
  // directly would pass even if the addon wiring were never made.
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
      // The D305 tap target, so the "no button" cases can assert that the
      // notification still reaches the page that CAN do the work.
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
    listAddonUpdates: async () => {
      if (updatable.value === 'throw') throw new Error('npm unreachable')
      return updatable.value
    },
    applyAddonUpdate: async (input) => {
      applied.push({ packageName: input.packageName, nodeId: input.nodeId })
      return failing.has(input.packageName)
        ? { ok: false, error: 'apply failed' }
        : { ok: true as const }
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
      // No snooze buttons: this suite asserts the update button and only it.
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
    updatable,
    failing,
  }
}

/** Raw `update.available`, exactly as the hub emitter shapes it. */
function updateAvailable(
  packages: readonly { name: string; node: string }[],
  target: 'addon' | 'server' = 'addon',
) {
  const rows = packages.map((pkg) => ({
    packageName: pkg.name,
    currentVersion: '0.1.47',
    latestVersion: '0.1.51',
    nodeId: pkg.node,
  }))
  const head = rows[0]!
  return createEvent(
    'update.available',
    { type: 'core', id: 'updates' },
    {
      target,
      packageName: head.packageName,
      currentVersion: head.currentVersion,
      latestVersion: head.latestVersion,
      packages: rows,
      nodeId: head.nodeId,
    },
  )
}

async function deliver(h: Harness, event: ReturnType<typeof updateAvailable>): Promise<void> {
  h.center.onSystemEvent(event)
  await vi.waitFor(() => {
    expect(h.rows()).toBeGreaterThan(0)
  })
  await h.center.drainNow()
}

/** The update button on the LAST notification that left the process. */
function updateButton(sends: readonly NcSendInput[]) {
  const actions = sends.at(-1)?.notification.actions ?? []
  return actions.find((action) => action.id === 'addon-update-apply')
}

/** Drive the REAL public route with the URL the notification carried. */
async function tap(h: Harness, url: string): Promise<string> {
  const { res, body } = fakeRes()
  await h.plane.handler({ url: url.slice(BASE.length), method: 'POST' } as never, res)
  return body()
}

afterEach(async () => {
  await Promise.all(centers.map((center) => center.stop()))
  centers.length = 0
})

describe('an addon-update notification carries a button that applies it', () => {
  it('names how many packages and which node, and is a background call', async () => {
    const h = await makeHarness({
      updatable: ['@camstack/addon-terminal', '@camstack/addon-recorder', '@camstack/addon-ai'],
    })
    await deliver(
      h,
      updateAvailable([
        { name: '@camstack/addon-terminal', node: 'agent-a' },
        { name: '@camstack/addon-recorder', node: 'agent-a' },
        { name: '@camstack/addon-ai', node: 'agent-a' },
      ]),
    )

    const button = updateButton(h.sends)
    expect(button?.label).toBe('Update 3 addons on agent-a')
    expect(button?.mode).toBe('background')
    expect(button?.destructive).toBe(true)
    // Train-bound closed vocabulary: an addon that emits an icon token the
    // running hub does not know loses the WHOLE notification to Zod.
    expect(button?.icon).toBeUndefined()
    expect(button?.url).toMatch(
      new RegExp(`^${BASE}${ROUTE_PREFIX}/[^?]+\\?exp=\\d+&sig=[0-9a-f]{64}$`),
    )
  })

  it('applies exactly the packages the row named, on the node it named', async () => {
    const h = await makeHarness({
      updatable: ['@camstack/addon-terminal', '@camstack/addon-recorder'],
    })
    await deliver(
      h,
      updateAvailable([
        { name: '@camstack/addon-terminal', node: 'agent-a' },
        { name: '@camstack/addon-recorder', node: 'agent-a' },
      ]),
    )
    await tap(h, updateButton(h.sends)!.url!)

    expect(h.applied).toEqual([
      { packageName: '@camstack/addon-terminal', nodeId: 'agent-a' },
      { packageName: '@camstack/addon-recorder', nodeId: 'agent-a' },
    ])
  })

  it('tells the operator it started, and then what actually landed', async () => {
    const h = await makeHarness({
      updatable: ['@camstack/addon-terminal', '@camstack/addon-recorder'],
    })
    await deliver(
      h,
      updateAvailable([
        { name: '@camstack/addon-terminal', node: 'agent-a' },
        { name: '@camstack/addon-recorder', node: 'agent-a' },
      ]),
    )
    const before = h.sends.length
    await tap(h, updateButton(h.sends)!.url!)

    const announcements = h.sends.slice(before).map((send) => send.notification.body)
    expect(announcements).toEqual(['Updating 2 addons on agent-a…', '2 addons updated on agent-a'])
    // Back to the target this delivery was addressed to — the only addressee
    // the grant can honestly name.
    expect(h.sends.slice(before).every((send) => send.targetId === 'target-1')).toBe(true)
  })

  it('states NO version — the one resolver reads that back at apply time (D313)', async () => {
    const h = await makeHarness({ updatable: ['@camstack/addon-terminal'] })
    await deliver(h, updateAvailable([{ name: '@camstack/addon-terminal', node: 'hub' }]))
    const before = h.sends.length
    await tap(h, updateButton(h.sends)!.url!)

    const said = h.sends
      .slice(before)
      .map((send) => `${send.notification.title} ${send.notification.body}`)
      .join(' ')
    expect(said).not.toContain('0.1.51')
    expect(said).not.toContain('0.1.47')
    expect(said).not.toContain('latest')
  })
})

describe('a second tap changes nothing', () => {
  it('spends the button once — the second tap says so and applies nothing more', async () => {
    const h = await makeHarness({ updatable: ['@camstack/addon-terminal'] })
    await deliver(h, updateAvailable([{ name: '@camstack/addon-terminal', node: 'hub' }]))
    const url = updateButton(h.sends)!.url!

    expect(await tap(h, url)).toContain('Done')
    expect(h.applied).toHaveLength(1)

    expect(await tap(h, url)).toContain('Already done')
    expect(h.applied).toHaveLength(1)
  })

  it('asks the registry what is STILL out of date and never re-applies what is not', async () => {
    // The operator applied two of the three from the Addons page before
    // tapping. A button that reported "3 updated" would be reporting work it
    // did not do.
    const h = await makeHarness({ updatable: ['@camstack/addon-ai'] })
    await deliver(
      h,
      updateAvailable([
        { name: '@camstack/addon-terminal', node: 'agent-a' },
        { name: '@camstack/addon-recorder', node: 'agent-a' },
        { name: '@camstack/addon-ai', node: 'agent-a' },
      ]),
    )
    await tap(h, updateButton(h.sends)!.url!)

    expect(h.applied).toEqual([{ packageName: '@camstack/addon-ai', nodeId: 'agent-a' }])
    expect(h.sends.at(-1)?.notification.body).toBe(
      'agent-a: 1 updated, 2 already current, 0 failed',
    )
  })

  it('applies NOTHING when the registry says everything is current, and says so', async () => {
    const h = await makeHarness({ updatable: [] })
    await deliver(h, updateAvailable([{ name: '@camstack/addon-terminal', node: 'hub' }]))
    const before = h.sends.length
    await tap(h, updateButton(h.sends)!.url!)

    expect(h.applied).toEqual([])
    expect(h.sends.slice(before).map((send) => send.notification.body)).toEqual([
      'Already up to date on hub — nothing to do',
    ])
  })

  it('changes nothing when it cannot read what needs updating', async () => {
    const h = await makeHarness({ updatable: 'throw' })
    await deliver(h, updateAvailable([{ name: '@camstack/addon-terminal', node: 'hub' }]))
    const before = h.sends.length
    expect(await tap(h, updateButton(h.sends)!.url!)).toContain('did not work')

    expect(h.applied).toEqual([])
    expect(h.sends.slice(before).map((send) => send.notification.body)).toEqual([
      'Could not read what needs updating on hub — nothing was changed. Open CamStack.',
    ])
  })

  it('reports a failure as a failure, naming the package', async () => {
    const h = await makeHarness({
      updatable: ['@camstack/addon-terminal', '@camstack/addon-recorder'],
      failing: ['@camstack/addon-recorder'],
    })
    await deliver(
      h,
      updateAvailable([
        { name: '@camstack/addon-terminal', node: 'hub' },
        { name: '@camstack/addon-recorder', node: 'hub' },
      ]),
    )
    const before = h.sends.length
    await tap(h, updateButton(h.sends)!.url!)

    const bodies = h.sends.slice(before).map((send) => send.notification.body)
    expect(bodies.at(-1)).toBe(
      'hub: 1 updated, 0 already current, 1 failed\n@camstack/addon-recorder',
    )
  })
})

describe('what the button REFUSES to be', () => {
  it('a row that spans several nodes gets no button — and still gets its notification', async () => {
    const h = await makeHarness({ updatable: ['@camstack/addon-terminal'] })
    // Two nodes in one row: the intake sets no single `nodeId`, and a button
    // that restarted addons on a node it could not name would be the blunt
    // fleet action nobody asked for.
    h.center.onSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'addon',
          packageName: '@camstack/addon-terminal',
          currentVersion: '0.1.47',
          latestVersion: '0.1.51',
          packages: [
            {
              packageName: '@camstack/addon-terminal',
              currentVersion: '0.1.47',
              latestVersion: '0.1.51',
              nodeId: 'hub',
            },
            {
              packageName: '@camstack/addon-recorder',
              currentVersion: '0.1.1',
              latestVersion: '0.1.2',
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
    expect(updateButton(h.sends)).toBeUndefined()
  })

  it("a NODE's own server update does not carry the addon-update button", async () => {
    // The server-update family is a different grant (D325). This button still
    // refuses that kind — applying addons is not applying a node reboot.
    const h = await makeHarness({ updatable: ['@camstack/server'] })
    await deliver(h, updateAvailable([{ name: '@camstack/server', node: 'hub' }], 'server'))

    expect(h.sends).toHaveLength(1)
    expect(updateButton(h.sends)).toBeUndefined()
  })

  it('a destination nobody owns gets no button — it gets the login-gated page', async () => {
    // The mute buttons already refuse an unowned target. This one refuses for a
    // stronger reason: a sequence button is authored per rule, this one appears
    // on every addon-update notification, so nobody chose it per button.
    const h = await makeHarness({ unowned: true, updatable: ['@camstack/addon-terminal'] })
    await deliver(h, updateAvailable([{ name: '@camstack/addon-terminal', node: 'hub' }]))

    expect(h.sends).toHaveLength(1)
    expect(updateButton(h.sends)).toBeUndefined()
    // The notification still reaches the page that CAN do it, behind a login.
    expect(h.sends[0]?.notification.clickUrl).toContain('/system/addons?node=hub')
  })

  it('a loopback-only install loses the button, never the notification', async () => {
    const h = await makeHarness({ baseUrl: null, updatable: ['@camstack/addon-terminal'] })
    await deliver(h, updateAvailable([{ name: '@camstack/addon-terminal', node: 'hub' }]))

    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.actions ?? []).toEqual([])
  })
})
