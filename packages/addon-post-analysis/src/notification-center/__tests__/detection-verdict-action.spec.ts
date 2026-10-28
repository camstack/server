/**
 * "Was this detection right?" — a notification button that marks the track for
 * retraining (#243), through the token-only action plane (D47).
 *
 * Same chain as server-update-action.spec.ts, asserted on what LEAVES the
 * process: a detection event -> the rule (`askVerdict`) -> the outbox -> the
 * minted buttons -> the real `NcActionPlane` handler -> the mark port and the
 * who/when ledger.
 */

import type { ServerResponse } from 'node:http'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestObjectEvent } from '../../__tests__/support/events.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcVerdictFrameOutcome } from '../center-deps.js'
import { NcActionPlane } from '../action-plane.js'
import { NcActionTokenRegistry, buildActionUrl, type NcActionGrant } from '../action-token.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const BASE = 'https://camstack.example.top'
const ROUTE_PREFIX = '/addon/pipeline-analytics/nc-action'
const SECRET = 'per-install-secret'
const T0 = 1_800_000_000_000
const ADMIN = { userId: 'admin-1', isAdmin: true }

type MarkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'trained' | 'budget' | 'unknown-track' }

interface HarnessOptions {
  readonly askVerdict?: boolean
  readonly unowned?: boolean
  /** The target kind's declared action budget (`TargetKindCaps.actions`). */
  readonly maxActions?: number
  readonly mark?: MarkOutcome
  /** The recording fallback's answer; absent = no fallback wired. */
  readonly frame?: NcVerdictFrameOutcome
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

async function makeHarness(options: HarnessOptions = {}) {
  const world = makeNcRecords()
  const maxActions = options.maxActions ?? 3
  const targets: readonly NcTargetRef[] = [
    {
      id: 'target-1',
      addonId: 'notifiers',
      name: 'phone',
      kind: 'ntfy',
      enabled: true,
      maxActions,
      ...(options.unowned === true ? {} : { ownerUserId: 'alice' }),
    },
  ]
  const sends: NcSendInput[] = []
  const marked: { deviceId: number; trackId: string }[] = []
  const framed: { deviceId: number; epochMs: number }[] = []
  let now = T0
  let built: NotificationCenter | null = null
  const events = [] as ReturnType<typeof makeTestObjectEvent>[]
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
      publicUrlBase: async () => BASE,
    },
    listObjectEventsSince: async (since) => events.filter((e) => e.timestamp >= since),
    listRecentTracks: async () => [],
    now: () => now,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
    mintActionUrl: async ({ id, expMs }) =>
      buildActionUrl({ baseUrl: BASE, routePrefix: ROUTE_PREFIX, id, secret: SECRET, expMs }),
    markTrackForRetrain: async (input) => {
      const outcome = options.mark ?? { ok: true as const }
      if (outcome.ok) marked.push(input)
      return outcome
    },
    ...(options.frame === undefined
      ? {}
      : {
          addVerdictFrameFromRecording: async (input: { deviceId: number; epochMs: number }) => {
            framed.push(input)
            return options.frame!
          },
        }),
  })
  built = center
  centers.push(center)
  await center.start({ evaluation: true })
  await center.buildProvider().createRule({
    caller: ADMIN,
    rule: NcRuleInputSchema.parse({
      name: 'person at gate',
      delivery: 'immediate',
      targets: [{ targetId: 'target-1' }],
      conditions: { classes: ['person'] },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      snoozeOptions: [],
      media: { attach: 'none' },
      ...(options.askVerdict === false ? {} : { askVerdict: true }),
    }),
  })
  const plane = new NcActionPlane({
    registry: center.actionTokenRegistry,
    secret: SECRET,
    logger: makeSilentLogger(),
    run: (grant) => center.runGrantedAction(grant),
    now: () => now,
  })
  return {
    center,
    world,
    sends,
    marked,
    framed,
    plane,
    fire: async (trackId: string) => {
      const event = makeTestObjectEvent({ trackId, deviceId: 101, timestamp: now, zones: [] })
      events.push(event)
      center.onObjectEventPersisted(event)
      await vi.waitFor(() => {
        expect(ncTable(world, 'outbox').size).toBeGreaterThan(0)
      })
      await center.drainNow()
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

type Harness = Awaited<ReturnType<typeof makeHarness>>

function button(h: Harness, id: string) {
  return (h.sends.at(-1)?.notification.actions ?? []).find((a) => a.id === id)
}

async function tap(h: Harness, url: string, method: 'GET' | 'POST' = 'POST'): Promise<string> {
  const { res, body } = fakeRes()
  await h.plane.handler({ url: url.slice(BASE.length), method } as never, res)
  return body()
}

function verdictRows(h: Harness): Record<string, unknown>[] {
  return [...ncTable(h.world, 'detection-verdicts').values()]
}

afterEach(async () => {
  await Promise.all(centers.map((c) => c.stop()))
  centers.length = 0
})

describe('a detection notification asks for a verdict only when the rule says so', () => {
  it('carries Correct and Wrong, as background calls', async () => {
    const h = await makeHarness()
    await h.fire('trk-1')
    expect(button(h, 'detection-verdict-correct')?.mode).toBe('background')
    expect(button(h, 'detection-verdict-wrong')?.mode).toBe('background')
  })

  it('carries nothing when askVerdict is off (the default)', async () => {
    const h = await makeHarness({ askVerdict: false })
    await h.fire('trk-1')
    expect(h.sends).toHaveLength(1)
    expect(button(h, 'detection-verdict-correct')).toBeUndefined()
    expect(button(h, 'detection-verdict-wrong')).toBeUndefined()
  })

  it('a destination nobody owns gets no button: there is no one to record', async () => {
    const h = await makeHarness({ unowned: true })
    await h.fire('trk-1')
    expect(button(h, 'detection-verdict-correct')).toBeUndefined()
  })
})

describe('tapping applies the mark exactly once and records who and when', () => {
  it('Correct marks the track and writes the ledger row', async () => {
    const h = await makeHarness()
    await h.fire('trk-1')
    h.advance(5_000)
    expect(await tap(h, button(h, 'detection-verdict-correct')!.url!)).toContain('Done')

    expect(h.marked).toEqual([{ deviceId: 101, trackId: 'trk-1' }])
    expect(verdictRows(h)).toHaveLength(1)
    const row = JSON.stringify(verdictRows(h)[0])
    expect(row).toContain('"verdict":"correct"')
    expect(row).toContain('"userId":"alice"')
    expect(row).toContain(String(T0 + 5_000))
  })

  it('Wrong marks the track and records the verdict, with no class', async () => {
    const h = await makeHarness()
    await h.fire('trk-1')
    await tap(h, button(h, 'detection-verdict-wrong')!.url!)
    expect(h.marked).toHaveLength(1)
    expect(JSON.stringify(verdictRows(h)[0])).toContain('"verdict":"wrong"')
  })

  it('a class button records the class the operator named', async () => {
    const h = await makeHarness({ maxActions: 4 })
    await h.fire('trk-1')
    const choice = (h.sends.at(-1)?.notification.actions ?? []).find((a) =>
      a.id.startsWith('detection-verdict-wrong:'),
    )
    expect(choice).toBeDefined()
    await tap(h, choice!.url!)
    expect(JSON.stringify(verdictRows(h)[0])).toContain(
      `"suggestedClass":"${choice!.id.split(':')[1]}"`,
    )
    expect(h.marked).toHaveLength(1)
  })

  it('a reused token is refused by name and marks nothing twice', async () => {
    const h = await makeHarness()
    await h.fire('trk-1')
    const url = button(h, 'detection-verdict-correct')!.url!
    expect(await tap(h, url)).toContain('Done')
    expect(await tap(h, url)).toContain('Already done')
    expect(h.marked).toHaveLength(1)
    expect(verdictRows(h)).toHaveLength(1)
  })

  it('an expired link is refused and marks nothing', async () => {
    const h = await makeHarness()
    await h.fire('trk-1')
    const url = button(h, 'detection-verdict-correct')!.url!
    h.advance(48 * 3_600_000)
    expect(await tap(h, url)).toContain('not valid')
    expect(h.marked).toEqual([])
  })

  it('names the reason when the retrain flow refuses the mark', async () => {
    const h = await makeHarness({ mark: { ok: false, reason: 'trained' } })
    await h.fire('trk-1')
    const page = await tap(h, button(h, 'detection-verdict-correct')!.url!)
    expect(page).toContain('Nothing was done')
    expect(page).toContain('already used for training')
    expect(verdictRows(h)).toHaveLength(0)
  })
})

describe('a verdict on a track that is gone still lands a training frame', () => {
  const GONE: MarkOutcome = { ok: false, reason: 'unknown-track' }

  it('falls back to the recording at the notification instant and records the verdict', async () => {
    const h = await makeHarness({ mark: GONE, frame: { ok: true } })
    await h.fire('trk-1')
    h.advance(30_000)
    const page = await tap(h, button(h, 'detection-verdict-wrong')!.url!)
    expect(page).toContain('Done')
    expect(h.framed).toEqual([{ deviceId: 101, epochMs: T0 }])
    expect(verdictRows(h)).toHaveLength(1)
    expect(JSON.stringify(verdictRows(h)[0])).toContain('"verdict":"wrong"')
  })

  it('a refused recording is named to the tapper and writes no ledger row', async () => {
    const h = await makeHarness({
      mark: GONE,
      frame: { ok: false, reason: 'still-unavailable' },
    })
    await h.fire('trk-1')
    const page = await tap(h, button(h, 'detection-verdict-correct')!.url!)
    expect(page).toContain('Nothing was done')
    expect(page).toContain('recording')
    expect(verdictRows(h)).toHaveLength(0)
  })

  it('other refusals (trained, budget) never reach the recording', async () => {
    const h = await makeHarness({ mark: { ok: false, reason: 'trained' }, frame: { ok: true } })
    await h.fire('trk-1')
    await tap(h, button(h, 'detection-verdict-correct')!.url!)
    expect(h.framed).toEqual([])
  })
})

describe('the registry names why a verdict token is unusable', () => {
  it('expired and already-used are different answers', () => {
    let now = T0
    const registry = new NcActionTokenRegistry(() => now)
    const grant: NcActionGrant = {
      kind: 'detection-verdict',
      id: 'g1',
      verdict: 'correct',
      trackId: 'trk-1',
      ruleId: 'r',
      ruleName: 'rule',
      userId: 'alice',
      deviceId: 101,
      actionId: 'detection-verdict-correct',
      expiresAt: T0 + 1_000,
    }
    registry.put(grant)
    expect(registry.claim('g1')).toEqual({ ok: true, grant })
    expect(registry.claim('g1')).toEqual({ ok: false, reason: 'already-used' })
    registry.put({ ...grant, id: 'g2' })
    now = T0 + 2_000
    expect(registry.claim('g2')).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('a channel with no buttons gets a link instead', () => {
  it('puts the links in the body, and keeps them out of the actions', async () => {
    const h = await makeHarness({ maxActions: 0 })
    await h.fire('trk-1')
    const sent = h.sends.at(-1)!.notification
    expect(sent.actions ?? []).toHaveLength(0)
    expect(sent.body).toContain(`${BASE}${ROUTE_PREFIX}/`)
    expect(sent.body).toContain('Correct')
    expect(sent.body).toContain('Wrong')
  })

  it('opening the link (a preview bot does) marks nothing; confirming does, once', async () => {
    const h = await makeHarness({ maxActions: 0 })
    await h.fire('trk-1')
    const link = /https:\/\/\S+correct\S*|https:\/\/\S+/.exec(h.sends.at(-1)!.notification.body)![0]
    const peek = await tap(h, link, 'GET')
    expect(peek).toContain('Confirm')
    expect(h.marked).toEqual([])
    expect(await tap(h, `${link}&confirm=1`, 'POST')).toContain('Done')
    expect(h.marked).toHaveLength(1)
  })
})
