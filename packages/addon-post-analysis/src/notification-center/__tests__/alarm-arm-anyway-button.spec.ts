/**
 * THE ARM ANYWAY BUTTON, end to end (D630): the real panel, the real centre,
 * the real outbox, the real button minter and the real public action route.
 *
 * The refusal notification is the ONLY place an Arm anyway lives, and the
 * button it carries is bound to that one refusal: its grant carries the
 * refusal id and nothing else, and the panel's refusal record decides the mode
 * and what is excluded. Every case here walks refusal → row → drained push →
 * minted URL → tap, because the join that can break is between those steps —
 * a row that froze no refusal id, a minter that ignored it, a grant routed to a
 * plain arm (which is refused again), or a grant that excluded ids of its own.
 *
 * And the other half of the same rule: every transition reaches an
 * alarm-family rule's targets (panel announceTargets are retired).
 */

import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  type AlarmArmMode,
  DeviceType,
  type IScopedLogger,
  NcRuleInputSchema,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcActionPlane } from '../action-plane.js'
import { buildActionUrl } from '../action-token.js'
import {
  makePanelContext,
  type NcTestLogLine,
  type NcTestPanelCap,
  TEST_PANEL_ID,
} from '../alarm/__tests__/panel-test-context.js'
import type { NcAlarmOpenDevice } from '../alarm/alarm-arm-guard.js'
import { ARM_ANYWAY_TTL_MS, NcAlarmPanelDevice } from '../alarm/alarm-panel-device.js'
import { ncAlarmPanelPort } from '../alarm/alarm-panel-port.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { type NcOutboxEntry, rowToEntry } from '../outbox.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const BASE = 'https://camstack.example.top'
const ROUTE_PREFIX = '/addon/pipeline-analytics/nc-action'
const SECRET = 'per-install-secret'
const PANEL_ID = TEST_PANEL_ID
const PORCH = 3243
const GARAGE = 4001

const PORCH_OPEN: NcAlarmOpenDevice = {
  deviceId: PORCH,
  name: 'Finestra porch',
  state: 'open',
  controllable: false,
  cap: 'contact',
}
const GARAGE_OPEN: NcAlarmOpenDevice = {
  deviceId: GARAGE,
  name: 'Garage',
  state: 'open',
  controllable: false,
  cap: 'contact',
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  { id: 'tgt-tablet', addonId: 'notifiers', name: 'tablet', kind: 'ntfy', enabled: true },
]

interface Harness {
  readonly center: NotificationCenter
  readonly panel: NcAlarmPanelDevice
  readonly cap: NcTestPanelCap
  readonly plane: NcActionPlane
  readonly sends: NcSendInput[]
  readonly logs: NcTestLogLine[]
  /** The centre's own logger — spied on by the no-target case. */
  readonly ncLogger: IScopedLogger
  /** What the openings guard answers, per mode. */
  readonly open: Map<AlarmArmMode, NcAlarmOpenDevice[]>
  rows(): NcOutboxEntry[]
}

const centers: NotificationCenter[] = []
const panels: NcAlarmPanelDevice[] = []

afterEach(async () => {
  for (const p of panels.splice(0)) p.stopCountdown()
  await Promise.all(centers.splice(0).map((c) => c.stop()))
  vi.useRealTimers()
})

/**
 * A real `ServerResponse` that keeps the body instead of writing it to a
 * socket — the handler uses only `writeHead` and `end`. No cast.
 */
class CapturedResponse extends ServerResponse {
  body = ''
  override end(chunk?: unknown): this {
    if (typeof chunk === 'string') this.body = chunk
    return this
  }
}

/** A real `IncomingMessage` for the public action route. */
function actionRequest(path: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.url = path
  req.method = 'POST'
  return req
}

/** Let the centre's serialized evaluation chain and the outbox writes run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function makeHarness(persisted: Record<string, unknown>): Promise<Harness> {
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const logs: NcTestLogLine[] = []
  const open = new Map<AlarmArmMode, NcAlarmOpenDevice[]>()
  const { ctx, cap } = makePanelContext({ ...persisted }, logs)
  const panel = new NcAlarmPanelDevice(ctx)
  panels.push(panel)
  let built: NotificationCenter | null = null
  const ncLogger = makeSilentLogger()
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: ncLogger,
    pruneWindows: async () => resolvePruneWindows({}),
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      buildActions: (input) => built?.mintButtons(input) ?? Promise.resolve([]),
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: PANEL_ID, type: DeviceType.AlarmPanel, name: 'Allarme', isCamera: false },
      { deviceId: PORCH, type: DeviceType.Sensor, name: 'Finestra porch', isCamera: false },
      { deviceId: GARAGE, type: DeviceType.Sensor, name: 'Garage', isCamera: false },
    ],
    // The cap calls a plain-arm / disarm button makes, landing on the REAL
    // panel's provider — the same seam the addon wires.
    actuate: async ({ cap: capName, method, args }) => {
      if (capName !== 'alarm-panel') return
      const provider = cap()
      if (method === 'disarm') await provider.disarm({ deviceId: PANEL_ID })
      if (method === 'arm') {
        const mode = args['mode']
        if (mode === 'home' || mode === 'away' || mode === 'night') {
          await provider.arm({ deviceId: PANEL_ID, mode })
        }
      }
    },
    mintActionUrl: async ({ id, expMs }) =>
      buildActionUrl({ baseUrl: BASE, routePrefix: ROUTE_PREFIX, id, secret: SECRET, expMs }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  built = center
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  center.setAlarmPanel(ncAlarmPanelPort(panel))
  panel.setPublishHook((report) => center.onAlarmPublish(report))
  // A CONTROLLABLE openings read; the announcements are the centre's own.
  const announcer = center.alarmArmGuard()
  panel.setArmGuard({
    openings: async (mode) => ({ open: [...(open.get(mode) ?? [])], unknown: [] }),
    secureOnArm: (devices) => announcer.secureOnArm(devices),
    announceRefusal: (input) => announcer.announceRefusal(input),
    announceCheckFailed: (input) => announcer.announceCheckFailed(input),
  })
  const plane = new NcActionPlane({
    registry: center.actionTokenRegistry,
    secret: SECRET,
    logger: makeSilentLogger(),
    run: (grant) => center.runGrantedAction(grant),
  })
  return {
    center,
    panel,
    cap: cap(),
    plane,
    sends,
    logs,
    ncLogger,
    open,
    rows: () =>
      [...(ncTable(world, 'outbox')?.entries() ?? [])]
        .map(([id, data]) => rowToEntry(id, data))
        .filter((entry): entry is NcOutboxEntry => entry !== null)
        .toSorted((a, b) => a.createdAt - b.createdAt),
  }
}

/** The refusal rows, oldest first. */
function refusalRows(h: Harness, targetId = 'tgt-phone'): NcOutboxEntry[] {
  return h
    .rows()
    .filter(
      (r) => r.targetId === targetId && r.payload.subject.systemEvent?.kind === 'alarm-arm-refused',
    )
}

/** Drain, and return the Arm anyway URL of the LAST push to `targetId`. */
async function armAnywayUrl(h: Harness, targetId = 'tgt-phone'): Promise<string> {
  await h.center.drainNow()
  const push = h.sends.filter((s) => s.targetId === targetId).at(-1)
  const button = push?.notification.actions?.find((a) => a.id === 'alarm-arm-anyway')
  if (button?.url === undefined) throw new Error(`no Arm anyway button on the push to ${targetId}`)
  return button.url
}

async function tap(h: Harness, url: string): Promise<string> {
  const req = actionRequest(url.slice(BASE.length))
  const res = new CapturedResponse(req)
  await h.plane.handler(req, res)
  return res.body
}

/** Arm away with Porch open — the refusal every case starts from. */
async function refuseAway(h: Harness): Promise<string> {
  h.open.set('away', [PORCH_OPEN])
  const outcome = await h.panel.armWith('away')
  if (outcome.outcome !== 'refused') throw new Error(`expected a refusal, got ${outcome.outcome}`)
  await flush()
  return outcome.refusalId
}

async function makeAlarmRule(
  center: NotificationCenter,
  targetIds: readonly string[],
  kinds: readonly string[],
): Promise<string> {
  const { rule } = await center.buildProvider().createRule({
    caller: { userId: 'admin', isAdmin: true },
    rule: NcRuleInputSchema.parse({
      name: 'Allarme',
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: [...kinds] } },
      targets: targetIds.map((targetId) => ({ targetId })),
      throttle: { cooldownSec: 0, scope: 'rule' },
    }),
  })
  return rule.id
}

describe('the Arm anyway on a refusal notification', () => {
  it('the refusal row freezes its id, and the button grants ONLY that id', async () => {
    const h = await makeHarness({ announceTargets: [] })
    const ruleId = await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arm-refused'])
    const refusalId = await refuseAway(h)
    const row = refusalRows(h)[0]
    expect(row?.ruleId).toBe(ruleId)
    expect(row?.payload.subject.systemEvent?.data).toMatchObject({ refusalId })
    const url = await armAnywayUrl(h)
    const push = h.sends.at(-1)?.notification
    // The body PINNED: the open sensor, then the button's own name.
    expect(push?.body).toBe('Open:\n• Finestra porch\nTap “Arm anyway” to arm with them excluded.')
    const button = push?.actions?.find((a) => a.id === 'alarm-arm-anyway')
    expect(push?.actions).toHaveLength(1)
    expect(button?.destructive).toBe(true)
    // Background POST, like every alarm button (aaf37d743).
    expect(button?.mode).toBe('background')
    const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
    const claim = h.center.actionTokenRegistry.claim(id)
    if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`)
    const { id: _id, deviceId, actionId, targetId, expiresAt, ...grant } = claim.grant
    expect(grant).toEqual({
      kind: 'alarm',
      action: 'arm-anyway',
      refusalId,
      panelDeviceId: PANEL_ID,
    })
    expect({ deviceId, actionId, targetId }).toEqual({
      deviceId: PANEL_ID,
      actionId: 'alarm-arm-anyway',
      targetId: 'tgt-phone',
    })
    // The TTL is the panel's own Arm anyway window.
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(ARM_ANYWAY_TTL_MS)
    expect(expiresAt - Date.now()).toBeGreaterThan(ARM_ANYWAY_TTL_MS - 5_000)
  })

  it('BOUND TO ITS REFUSAL: the tap arms around exactly what the refusal showed', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 30 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arm-refused'])
    await refuseAway(h)
    const body = await tap(h, await armAnywayUrl(h))
    expect(body).toMatch(/^Done:/)
    expect(h.panel.currentState()).toBe('arming')
    expect(h.panel.excludedDevices()).toEqual([PORCH])
  })

  it('ONE-SHOT: the same token twice is refused, a second token for the refusal is "used"', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 30 })
    await makeAlarmRule(h.center, ['tgt-phone', 'tgt-tablet'], ['alarm-arm-refused'])
    await refuseAway(h)
    const phone = await armAnywayUrl(h, 'tgt-phone')
    const tablet = await armAnywayUrl(h, 'tgt-tablet')
    expect(await tap(h, phone)).toMatch(/^Done:/)
    expect(await tap(h, phone)).toContain('Already done — this button had been used.')
    // The tablet's copy is a DIFFERENT token for the same refusal: the panel's
    // own one-shot answers it.
    expect(await tap(h, tablet)).toBe('Nothing was done: Already used')
    expect(h.panel.currentState()).toBe('arming')
  })

  it('STALE: the operator armed home from the app in between — nothing is armed away', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arm-refused'])
    await refuseAway(h)
    const url = await armAnywayUrl(h)
    await h.cap.arm({ deviceId: PANEL_ID, mode: 'home' })
    expect(h.panel.currentState()).toBe('armed_home')
    expect(await tap(h, url)).toBe(
      'Nothing was done: The alarm changed since this notification — nothing was armed',
    )
    expect(h.panel.currentState()).toBe('armed_home')
    await expect(
      h.center.runGrantedAction({
        kind: 'alarm',
        action: 'arm-anyway',
        refusalId: 'refusal:none',
        panelDeviceId: PANEL_ID,
        id: 'x',
        deviceId: PANEL_ID,
        actionId: 'alarm-arm-anyway',
        expiresAt: Date.now() + 1_000,
      }),
    ).rejects.toThrow('This refusal is no longer current — arm again')
  })

  it('EXPIRED: past ARM_ANYWAY_TTL_MS the token is dead, and so is the refusal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1_800_000_000_000))
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 30 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arm-refused'])
    const refusalId = await refuseAway(h)
    const url = await armAnywayUrl(h)
    vi.setSystemTime(new Date(1_800_000_000_000 + ARM_ANYWAY_TTL_MS + 1))
    expect(await tap(h, url)).toContain('This link is not valid.')
    expect(await h.panel.armAnyway(refusalId)).toEqual({ outcome: 'rejected', reason: 'expired' })
    expect(h.panel.currentState()).toBe('disarmed')
  })

  it('NEW BLOCKER: the tap refuses again, and the NEW refusal has its own button', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 30 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-arm-refused'])
    const first = await refuseAway(h)
    const url = await armAnywayUrl(h)
    h.open.set('away', [PORCH_OPEN, GARAGE_OPEN])
    expect(await tap(h, url)).toBe(
      'Nothing was done: Something else is open now — see the new notification',
    )
    await flush()
    expect(h.panel.currentState()).toBe('disarmed')
    const rows = refusalRows(h)
    expect(rows).toHaveLength(2)
    const second = rows[1]?.payload.subject.systemEvent?.data['refusalId']
    expect(second).not.toBe(first)
    // Every device that blocks NOW (Task 6 ruling: no ping-pong between two
    // open sensors), so this row's own Arm anyway can arm around both.
    const push = await armAnywayUrl(h)
    expect(h.sends.at(-1)?.notification.body).toBe(
      'Open:\n• Finestra porch\n• Garage\nTap “Arm anyway” to arm with them excluded.',
    )
    expect(await tap(h, push)).toMatch(/^Done:/)
    expect(h.panel.currentState()).toBe('arming')
    expect(h.panel.excludedDevices()).toEqual([PORCH, GARAGE])
  })
})

describe('every transition reaches alarm-rule targets (panel announce retired)', () => {
  it('arming, armed, pending, triggered, rearmed, disarmed — in order, to t1', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date(1_800_000_000_000))
    const h = await makeHarness({
      announceTargets: [],
      exitDelaySec: 30,
      entryDelaySec: 20,
      triggeredDurationSec: 10,
    })
    const ruleId = await makeAlarmRule(
      h.center,
      ['tgt-phone'],
      [
        'alarm-arming',
        'alarm-armed',
        'alarm-pending',
        'alarm-triggered',
        'alarm-rearmed',
        'alarm-disarmed',
      ],
    )
    expect((await h.panel.armWith('away')).outcome).toBe('arming')
    await flush()
    vi.advanceTimersByTime(31_000)
    await flush()
    await h.cap.trigger({ deviceId: PANEL_ID })
    await flush()
    vi.advanceTimersByTime(21_000)
    await flush()
    vi.advanceTimersByTime(11_000)
    await flush()
    await h.cap.disarm({ deviceId: PANEL_ID })
    await flush()
    const rows = h.rows()
    expect(rows.every((r) => r.targetId === 'tgt-phone')).toBe(true)
    expect(rows.every((r) => r.ruleId === ruleId)).toBe(true)
    expect(rows.map((r) => r.payload.subject.systemEvent?.kind)).toEqual([
      'alarm-arming',
      'alarm-armed',
      'alarm-pending',
      'alarm-triggered',
      'alarm-rearmed',
      'alarm-disarmed',
    ])
    const pending = rows[2]?.payload.subject.systemEvent
    expect(pending?.titleKey).toBe('system.alarm-pending.title.away')
    expect(pending?.textParams).toMatchObject({ seconds: '20' })
  })

  it('a rule delivers once — there is no second panel-announce push', async () => {
    const h = await makeHarness({ announceTargets: ['tgt-tablet'], exitDelaySec: 0 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-armed'])
    await h.panel.armWith('home')
    await flush()
    const rows = h.rows()
    expect(rows.filter((r) => r.targetId === 'tgt-phone')).toHaveLength(1)
    // Leftover announceTargets on the panel are ignored.
    expect(rows.filter((r) => r.targetId === 'tgt-tablet')).toHaveLength(0)
  })

  it('with no alarm rule, a transition enqueues nothing', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0 })
    await h.panel.armWith('home')
    await flush()
    expect(h.rows()).toEqual([])
  })
})

// ── "Bypass this input until disarm", end to end ─────────────────────────────

const PIR = 3301
const CAMERA = 102

/** The match a rule hands the panel — the same shape `fireRefFor` builds. */
function pirMatch(ruleId: string): Parameters<NcAlarmPanelDevice['triggerFromRule']>[0] {
  return {
    ruleId,
    ruleName: 'Perimetro',
    deviceId: CAMERA,
    sourceDeviceId: PIR,
    recordId: `pir-row-${String(Date.now())}`,
    timestamp: Date.now(),
  }
}

/** Drain, and return the Bypass button of the last push to `targetId` that carries one. */
async function bypassUrl(h: Harness, targetId = 'tgt-phone'): Promise<string> {
  await h.center.drainNow()
  const push = h.sends
    .filter((s) => s.targetId === targetId)
    .findLast((s) => s.notification.actions?.some((a) => a.id === 'alarm-bypass-input') === true)
  const button = push?.notification.actions?.find((a) => a.id === 'alarm-bypass-input')
  if (button?.url === undefined) throw new Error(`no Bypass button on a push to ${targetId}`)
  return button.url
}

describe('the Bypass-this-input button on an alarm trigger notification', () => {
  const SOURCE_RULE = 'rule-perimetro'

  it('the triggered push carries Bypass beside Disarm, and its grant names ONLY the (rule, input)', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0, entryDelaySec: 0 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    await h.panel.armWith('away')
    expect(h.panel.triggerFromRule(pirMatch(SOURCE_RULE))).toBe('accepted')
    await flush()
    const url = await bypassUrl(h)
    const push = h.sends.at(-1)?.notification
    expect(push?.actions?.map((a) => a.id)).toEqual(['alarm-disarm', 'alarm-bypass-input'])
    const button = push?.actions?.find((a) => a.id === 'alarm-bypass-input')
    expect(button?.mode).toBe('background')
    const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
    const claim = h.center.actionTokenRegistry.claim(id)
    if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`)
    const { id: _id, deviceId: _d, actionId, targetId: _t, expiresAt: _e, ...grant } = claim.grant
    expect(actionId).toBe('alarm-bypass-input')
    expect(grant).toEqual({
      kind: 'alarm',
      action: 'bypass-input',
      panelDeviceId: PANEL_ID,
      ruleId: SOURCE_RULE,
      ruleName: 'Perimetro',
      inputDeviceId: PIR,
      cameraId: CAMERA,
      notedAt: expect.any(Number),
    })
  })

  it('the tap bypasses that input: the next match is dropped, the siren is not cancelled', async () => {
    const h = await makeHarness({
      announceTargets: [],
      exitDelaySec: 0,
      entryDelaySec: 0,
      triggeredDurationSec: 0,
      postTriggeredAction: 'doNothing',
    })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    await h.panel.armWith('away')
    h.panel.triggerFromRule(pirMatch(SOURCE_RULE))
    await flush()
    expect(await tap(h, await bypassUrl(h))).toMatch(/^Done:/)
    expect(h.panel.currentState()).toBe('triggered')
    expect(h.panel.inputBypasses()).toEqual([
      expect.objectContaining({ ruleId: SOURCE_RULE, deviceId: PIR }),
    ])
    expect(h.panel.triggerFromRule(pirMatch(SOURCE_RULE))).toBe('ignored-bypassed')
    await h.panel.disarm()
    await h.panel.armWith('away')
    // A NEW session: watched again.
    expect(h.panel.triggerFromRule(pirMatch(SOURCE_RULE))).toBe('accepted')
  })

  it('a tap after the alarm was DISARMED bypasses nothing and says why', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0, entryDelaySec: 0 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    await h.panel.armWith('away')
    h.panel.triggerFromRule(pirMatch(SOURCE_RULE))
    await flush()
    const url = await bypassUrl(h)
    await h.panel.disarm()
    expect(await tap(h, url)).toBe('Nothing was done: The alarm is disarmed — nothing to bypass')
    expect(h.panel.inputBypasses()).toEqual([])
  })

  it('a FORGED signature is refused before anything runs (token-only auth, D47)', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0, entryDelaySec: 0 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    await h.panel.armWith('away')
    h.panel.triggerFromRule(pirMatch(SOURCE_RULE))
    await flush()
    const real = await bypassUrl(h)
    const forged = new URL(real)
    forged.searchParams.set('sig', '0'.repeat(64))
    expect(await tap(h, forged.toString())).not.toMatch(/^Done:/)
    expect(h.panel.inputBypasses()).toEqual([])
    // …and the genuine token, untouched by the forged attempt, still works.
    expect(await tap(h, real)).toMatch(/^Done:/)
    expect(h.panel.inputBypasses()).toHaveLength(1)
  })

  it('the app bridge bypasses a REAL alarm rule input, and the live view reports it', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0, entryDelaySec: 0 })
    const { rule } = await h.center.buildProvider().createRule({
      caller: { userId: 'admin', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: 'Finestra porch aperta',
        delivery: 'device-event',
        conditions: {
          devices: [PORCH],
          sensorKinds: ['contact'],
          deviceState: { deviceId: PANEL_ID, states: ['armed_away'] },
        },
        targets: [{ targetId: 'tgt-phone' }],
        throttle: { cooldownSec: 0, scope: 'rule' },
      }),
    })
    const actions = h.center.alarmActions()
    // Disarmed: nothing to bypass.
    expect(await actions.bypassInput({ ruleId: rule.id, deviceId: PORCH }, 'admin')).toEqual({
      outcome: 'refused',
      reason: 'disarmed',
    })
    await h.panel.armWith('away')
    // Not an input of that rule / not a rule at all.
    expect(await actions.bypassInput({ ruleId: rule.id, deviceId: GARAGE }, 'admin')).toEqual({
      outcome: 'refused',
      reason: 'not-an-input',
    })
    expect(await actions.bypassInput({ ruleId: 'nope', deviceId: PORCH }, 'admin')).toEqual({
      outcome: 'refused',
      reason: 'not-an-input',
    })
    expect(await actions.bypassInput({ ruleId: rule.id, deviceId: PORCH }, 'admin')).toEqual({
      outcome: 'bypassed',
      reason: null,
    })
    const status = await actions.status()
    expect(status.live?.state).toBe('armed_away')
    expect(status.live?.bypassedInputs).toEqual([
      {
        ruleId: rule.id,
        ruleName: 'Finestra porch aperta',
        deviceId: PORCH,
        name: 'Finestra porch',
        since: expect.any(Number),
        dropped: 0,
      },
    ])
    await h.panel.disarm()
    expect((await actions.status()).live?.bypassedInputs).toEqual([])
  })

  it('a MANUAL trigger (no rule, no input) carries no Bypass button', async () => {
    const h = await makeHarness({ announceTargets: [], exitDelaySec: 0, entryDelaySec: 0 })
    await makeAlarmRule(h.center, ['tgt-phone'], ['alarm-triggered'])
    await h.panel.armWith('away')
    await h.cap.trigger({ deviceId: PANEL_ID })
    await flush()
    await h.center.drainNow()
    const push = h.sends.at(-1)?.notification
    expect(push?.actions?.map((a) => a.id)).toEqual(['alarm-disarm'])
  })
})
