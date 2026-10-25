/**
 * The per-camera notification mute must STOP THE WORK, not persist a boolean.
 *
 * A switch that saves and does nothing is the failure this repo keeps
 * shipping. So every assertion here is about the OUTBOX — the durable
 * artefact a notification actually is — and never about the stored flag.
 *
 * It also pins the two things that make an indefinite silence safe:
 *  - the mute is per CAMERA, so an unmuted camera is unaffected by it;
 *  - the drop is LOGGED at info, because a branch that silently drops work is
 *    exactly what left a live rule unable to fire for fifteen hours.
 */
import type { InMemoryRecords } from '@camstack/types'
import type { AudioEvent, NcRuleInput, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import {
  completeLoggerStub,
  ncPruneWindowsPort,
  makeNcRecords,
  ncTable,
} from './support/nc-test-deps.js'
import { makeTestAudioEvent, makeTestObjectEvent } from '../../__tests__/support/events.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CALLER = { userId: 'admin-42', isAdmin: true }

interface LoggedLine {
  readonly level: 'info' | 'warn' | 'debug' | 'error'
  readonly message: string
  readonly tags?: Record<string, unknown>
}

interface Harness {
  readonly center: NotificationCenter
  readonly store: FakeSettingsStore
  readonly world: InMemoryRecords
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
}

function makeRuleInput(overrides: Record<string, unknown> = {}): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'person rule',
    delivery: 'immediate',
    targets: [{ targetId: 'tgt-1' }],
    conditions: { classes: ['person'] },
    ...overrides,
  })
}

function makeEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return makeTestObjectEvent({
    deviceId: 104,
    timestamp: 100_000,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: ['gate'],
    ...overrides,
  })
}

function makeAudioEvent(overrides: Partial<AudioEvent> = {}): AudioEvent {
  return makeTestAudioEvent({
    deviceId: 104,
    timestamp: 100_000,
    classification: { className: 'dog', score: 0.92 },
    ...overrides,
  })
}

function makeHarness(): Harness {
  const store = makeFakeSettingsStore()
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const lines: LoggedLine[] = []
  const record =
    (level: LoggedLine['level']) =>
    (message: string, opts?: { tags?: Record<string, unknown> }): void => {
      lines.push({ level, message, ...(opts?.tags ? { tags: opts.tags } : {}) })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: (): unknown => logger,
  }
  const targets: NcTargetRef[] = [
    { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
  ]
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: completeLoggerStub(logger),
    pruneWindows: ncPruneWindowsPort(),
    listUsers: async () => [],
    getDeviceRoute: async () => null,
    dispatcher: {
      listTargets: async () => targets,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Driveway',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    now: () => 100_000,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  return { center, store, world, sends, lines }
}

function outboxIds(world: InMemoryRecords): string[] {
  return [...(ncTable(world, 'outbox')?.keys() ?? [])]
}

describe('per-camera notification mute — OFF stops the work', () => {
  let h: Harness

  afterEach(async () => {
    await h.center.stop()
  })

  async function boot(): Promise<ReturnType<NotificationCenter['buildProvider']>> {
    h = makeHarness()
    await h.center.start({ evaluation: true })
    const provider = h.center.buildProvider()
    await provider.createRule({ rule: makeRuleInput(), caller: CALLER })
    return provider
  }

  it('control: an unmuted camera enqueues a notification', async () => {
    await boot()
    h.center.onObjectEventPersisted(makeEvent({ deviceId: 104 }))
    await vi.waitFor(() => expect(outboxIds(h.world)).toHaveLength(1))
  })

  it('a MUTED camera enqueues NOTHING for a matching event', async () => {
    const provider = await boot()
    await provider.setDeviceMuted({ deviceId: 104, muted: true })

    h.center.onObjectEventPersisted(makeEvent({ deviceId: 104 }))

    // Give the evaluation chain a chance to do the wrong thing.
    await vi.waitFor(() => expect(h.lines.some((l) => l.message.includes('muted'))).toBe(true))
    expect(outboxIds(h.world)).toEqual([])
    expect(h.sends).toEqual([])
  })

  it('the mute is per CAMERA — another camera still notifies', async () => {
    const provider = await boot()
    await provider.setDeviceMuted({ deviceId: 104, muted: true })

    h.center.onObjectEventPersisted(makeEvent({ deviceId: 102 }))
    await vi.waitFor(() => expect(outboxIds(h.world)).toHaveLength(1))
  })

  it('the mute covers EVERY subject kind, not just object events', async () => {
    const provider = await boot()
    await provider.createRule({
      rule: makeRuleInput({ name: 'audio rule', conditions: { audioClasses: ['dog'] } }),
      caller: CALLER,
    })
    await provider.setDeviceMuted({ deviceId: 104, muted: true })

    h.center.onAudioEventPersisted(makeAudioEvent({ deviceId: 104 }))
    await vi.waitFor(() => expect(h.lines.some((l) => l.message.includes('muted'))).toBe(true))
    expect(outboxIds(h.world)).toEqual([])
  })

  it('unmuting restores delivery', async () => {
    const provider = await boot()
    await provider.setDeviceMuted({ deviceId: 104, muted: true })
    await provider.setDeviceMuted({ deviceId: 104, muted: false })

    h.center.onObjectEventPersisted(makeEvent({ deviceId: 104 }))
    await vi.waitFor(() => expect(outboxIds(h.world)).toHaveLength(1))
  })

  it('the drop is LOGGED at info, with the deviceId tag', async () => {
    // Silence that produces no line reads as "nothing happened" — the exact
    // trap that hid a three-hour media blackout and a rule that had stopped
    // matching entirely.
    const provider = await boot()
    await provider.setDeviceMuted({ deviceId: 104, muted: true })
    h.center.onObjectEventPersisted(makeEvent({ deviceId: 104 }))

    await vi.waitFor(() => {
      const line = h.lines.find((l) => l.message.includes('muted'))
      expect(line).toBeDefined()
      expect(line?.level).toBe('info')
      expect(line?.tags).toMatchObject({ deviceId: 104 })
    })
  })

  it('listDeviceMutes reports what the switch group renders', async () => {
    const provider = await boot()
    await provider.setDeviceMuted({ deviceId: 102, muted: true })
    await provider.setDeviceMuted({ deviceId: 104, muted: true })
    expect(await provider.listDeviceMutes({})).toEqual({ mutedDeviceIds: [102, 104] })
  })
})
