/**
 * The dispatcher, rendering through the TEXT CATALOG.
 *
 * Everything a delivered notification says now comes from one place, so these
 * tests are about the SEAMS rather than about the words:
 *
 *  - the English default body is byte-for-byte what the hard-coded one produced
 *    (equivalence is the whole claim of this change);
 *  - the Italian one is the same sentence in Italian, plural nouns included;
 *  - a rule's own template still wins, and the COMPOSITE variables work inside
 *    it — that is the property that makes the catalog useful to an operator
 *    rather than a wall he has to route around;
 *  - a system-event row renders from the KEY + PARAMS frozen at intake, while a
 *    row enqueued BEFORE this deploy still renders from the title/body frozen
 *    on it. A durable outbox row waiting on an unreachable target must not lose
 *    its words on the way through.
 */

import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

function makeEntry(
  payload: Partial<NcOutboxPayload> = {},
  overrides: Partial<NcOutboxEntry> = {},
): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 104,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Person at gate',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 104,
        className: 'person',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
      ...payload,
    },
    ...overrides,
  }
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
]

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
}

function makeHarness(texts: NcTextCatalog, deviceName = 'Front door'): Harness {
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    texts,
    listTargets: async () => TARGETS,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => deviceName,
    getZoneNames: async () => [{ id: 'z1', name: 'gate' }],
  })
  return { dispatcher, sends }
}

async function deliver(texts: NcTextCatalog, entry: NcOutboxEntry): Promise<NcSendInput> {
  const h = makeHarness(texts)
  await h.dispatcher.deliver(entry)
  const sent = h.sends[0]
  if (sent === undefined) throw new Error('nothing was sent')
  return sent
}

const en = (): NcTextCatalog => new NcTextCatalog()
const italian = (): NcTextCatalog => new NcTextCatalog({ language: 'it' })

describe('detection defaults', () => {
  it('reproduces the hard-coded English body exactly', async () => {
    const sent = await deliver(en(), makeEntry())
    expect(sent.notification.body).toBe('Person on front door')
    expect(sent.notification.title).toBe('Person at gate')
  })

  it('carries the label and the zone names, English', async () => {
    const sent = await deliver(
      en(),
      makeEntry({
        subject: {
          deviceId: 104,
          className: 'person',
          label: 'John',
          zones: ['z1'],
          timestamp: 1,
        },
      }),
    )
    expect(sent.notification.body).toBe('Person (John) on front door in gate')
  })

  it('says the visit ended on a track-end row', async () => {
    const sent = await deliver(en(), makeEntry({}, { recordKind: 'track-end' }))
    expect(sent.notification.body).toBe('Person on front door — visit ended')
  })

  it('says the same thing in Italian', async () => {
    const sent = await deliver(
      italian(),
      makeEntry({
        subject: { deviceId: 104, className: 'person', label: 'John', zones: ['z1'], timestamp: 1 },
      }),
    )
    expect(sent.notification.body).toBe('Persona (John) su front door in gate')
  })

  it('an UNKNOWN class keeps its raw name, in both languages', async () => {
    const entry = makeEntry({
      subject: { deviceId: 104, className: 'forklift', zones: [], timestamp: 1 },
    })
    expect((await deliver(en(), entry)).notification.body).toBe('Forklift on front door')
    expect((await deliver(italian(), entry)).notification.body).toBe('Forklift su front door')
  })

  it('a hub OVERRIDE beats the shipped file', async () => {
    const texts = new NcTextCatalog({
      language: 'it',
      overrides: { it: { 'detection.body': '{{subject}} @ {{camera}}' } },
    })
    const sent = await deliver(texts, makeEntry())
    expect(sent.notification.body).toBe('Persona @ front door')
  })
})

describe('rule templates', () => {
  it('a rule template still wins over the catalog', async () => {
    const sent = await deliver(
      italian(),
      makeEntry({ template: { title: 'Mio titolo', body: 'Guarda {{camera}}' } }),
    )
    expect(sent.notification.title).toBe('Mio titolo')
    expect(sent.notification.body).toBe('Guarda front door')
  })

  it('COMPOSITE placeholders work inside a rule template', async () => {
    const sent = await deliver(
      italian(),
      makeEntry({
        template: { body: 'Rilevato {{subject}}{{inZones}} — {{camera}}' },
        subject: { deviceId: 104, className: 'vehicle', zones: ['z1'], timestamp: 1 },
      }),
    )
    expect(sent.notification.body).toBe('Rilevato veicolo in gate — front door')
  })

  it('{{op}} works inside a rule template on an occupancy row', async () => {
    const sent = await deliver(
      italian(),
      makeEntry({
        template: { body: '{{zone}} è {{op}} ({{count}}/{{capacity}})' },
        subject: {
          deviceId: 104,
          className: 'person',
          zones: [],
          timestamp: 1,
          occupancy: {
            zone: 'Cortile',
            count: 3,
            capacity: 2,
            occupied: true,
          },
        },
      }),
    )
    expect(sent.notification.body).toBe('Cortile è occupata (3/2)')
  })

  it('a missing var still renders EMPTY inside a rule template', async () => {
    const sent = await deliver(en(), makeEntry({ template: { body: 'x{{nope}}y' } }))
    expect(sent.notification.body).toBe('Xy')
  })
})

describe('occupancy defaults', () => {
  const occupancyEntry = (occupied: boolean, zone?: string): NcOutboxEntry =>
    makeEntry({
      subject: {
        deviceId: 104,
        className: 'person',
        zones: [],
        timestamp: 1,
        occupancy: {
          ...(zone !== undefined ? { zone } : {}),
          count: occupied ? 3 : 0,
          capacity: 2,
          occupied,
        },
      },
    })

  it('reproduces the hard-coded English body exactly', async () => {
    expect((await deliver(en(), occupancyEntry(true, 'Yard'))).notification.body).toBe(
      'Yard occupied (3/2)',
    )
    expect((await deliver(en(), occupancyEntry(false, 'Yard'))).notification.body).toBe(
      'Yard free (0/2)',
    )
  })

  it('a frame-scoped edge falls back to the camera name for the scope', async () => {
    expect((await deliver(en(), occupancyEntry(true))).notification.body).toBe(
      'Front door occupied (3/2)',
    )
  })

  it('says the same thing in Italian', async () => {
    expect((await deliver(italian(), occupancyEntry(true, 'Cortile'))).notification.body).toBe(
      'Cortile occupata (3/2)',
    )
    expect((await deliver(italian(), occupancyEntry(false, 'Cortile'))).notification.body).toBe(
      'Cortile libera (0/2)',
    )
  })
})

describe('system events', () => {
  const systemEntry = (
    systemEvent: NonNullable<NcOutboxPayload['subject']['systemEvent']>,
  ): NcOutboxEntry =>
    makeEntry({
      subject: {
        deviceId: 101,
        className: 'system',
        zones: [],
        timestamp: 1,
        systemEvent,
      },
    })

  it('renders from the KEY + PARAMS frozen at intake, in both languages', async () => {
    const entry = systemEntry({
      kind: 'device-offline',
      subject: 'device:101',
      titleKey: 'system.device-offline.title',
      bodyKey: 'system.device-offline.body',
      textParams: { deviceId: '101', deviceName: 'Vialetto' },
      deviceId: 101,
      data: {},
    })
    const english = await deliver(en(), entry)
    expect(english.notification.title).toBe('Offline — Vialetto')
    expect(english.notification.body).toBe('Device Vialetto is offline')

    const italiano = await deliver(italian(), entry)
    expect(italiano.notification.title).toBe('Non raggiungibile — Vialetto')
    expect(italiano.notification.body).toBe('Il dispositivo Vialetto è offline')
  })

  it('a LEGACY row — frozen title/body, no keys — still renders its own words', async () => {
    // Exactly the shape an outbox row enqueued before this deploy carries.
    const sent = await deliver(
      italian(),
      systemEntry({
        kind: 'camera-offline',
        subject: 'camera:101',
        title: 'Camera offline',
        body: 'Camera 101 is offline',
        deviceId: 101,
        data: {},
      }),
    )
    expect(sent.notification.title).toBe('Camera offline')
    // The frozen English sentence, NOT the Italian catalog one: the row was
    // written with its words and keeps them.
    expect(sent.notification.body).toBe('Camera 101 is offline')
  })

  it('the KEY wins when a row carries both — a re-worded catalog reaches old rows too', async () => {
    // An IN-FLIGHT row from before the generic rename: camera-worded kind,
    // camera-worded keys, and `{{deviceId}}` as its only param. It must still
    // render a whole sentence — the catalog keeps those keys for exactly as
    // long as such a row can exist, and the dispatcher defaults `deviceName`
    // to the frozen id so the new wording has no hole in it.
    const sent = await deliver(
      italian(),
      systemEntry({
        kind: 'camera-offline',
        subject: 'camera:101',
        title: 'Camera offline',
        body: 'Camera 101 is offline',
        titleKey: 'system.camera-offline.title',
        bodyKey: 'system.camera-offline.body',
        textParams: { deviceId: '101' },
        deviceId: 101,
        data: {},
      }),
    )
    expect(sent.notification.body).toBe('Il dispositivo 101 è offline')
  })

  it('a row whose key nothing carries falls back to its frozen body', async () => {
    const sent = await deliver(
      en(),
      systemEntry({
        kind: 'camera-offline',
        subject: 'camera:101',
        title: 'Frozen title',
        body: 'Frozen body',
        titleKey: 'system.no-such-kind.title',
        bodyKey: 'system.no-such-kind.body',
        textParams: {},
        deviceId: 101,
        data: {},
      }),
    )
    expect(sent.notification.title).toBe('Frozen title')
    expect(sent.notification.body).toBe('Frozen body')
  })
})

describe('the default catalog', () => {
  it('a dispatcher wired WITHOUT a catalog still speaks — the shipped English one', async () => {
    const sends: NcSendInput[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Front door',
    })
    await dispatcher.deliver(makeEntry())
    expect(sends[0]?.notification.body).toBe('Person on front door')
  })
})

/**
 * A parcel is TWO pieces of news, and before this they were one sentence.
 *
 * Measured 2026-09-08: the operator received a second notification after he
 * had already collected the parcel. It was not a duplicate — it was the
 * pick-up, rendered through `detection.title` / `detection.body`, so it
 * arrived titled with the delivery rule's own name ("Consegna pacco") and
 * worded identically to the delivery. Indistinguishable is the same thing as
 * duplicated, to the person reading it.
 */
describe('package phases', () => {
  const packaged = (phase: 'delivered' | 'picked-up'): NcOutboxEntry =>
    makeEntry(
      {
        ruleName: 'Parcel delivery (entrance)',
        subject: {
          deviceId: 104,
          className: 'package',
          zones: ['z1'],
          timestamp: 1,
          packagePhase: phase,
        },
      },
      { recordKind: 'package-event' },
    )

  it('words a delivery as a delivery', async () => {
    const sent = await deliver(en(), packaged('delivered'))
    expect(sent.notification.title).toBe('Parcel delivered')
    expect(sent.notification.body).toBe('Delivered at front door in gate')
  })

  it('words an unconfirmed delivery as a possible parcel', async () => {
    const entry = packaged('delivered')
    const sent = await deliver(en(), {
      ...entry,
      payload: {
        ...entry.payload,
        subject: { ...entry.payload.subject, packagePossible: true },
      },
    })
    expect(sent.notification.title).toBe('Possible parcel')
    expect(sent.notification.body).toBe('Possible parcel at front door in gate')
  })

  it('words a pick-up as a pick-up, not as the delivery rule', async () => {
    const sent = await deliver(en(), packaged('picked-up'))
    expect(sent.notification.title).toBe('Parcel collected')
    expect(sent.notification.body).toBe('Collected from front door in gate')
  })

  it('never renders the two phases the same way', async () => {
    const a = await deliver(en(), packaged('delivered'))
    const b = await deliver(en(), packaged('picked-up'))
    expect(a.notification.title).not.toBe(b.notification.title)
    expect(a.notification.body).not.toBe(b.notification.body)
  })

  it('says both in Italian', async () => {
    const a = await deliver(italian(), packaged('delivered'))
    const b = await deliver(italian(), packaged('picked-up'))
    expect(a.notification.title).toBe('Pacco consegnato')
    expect(b.notification.title).toBe('Pacco ritirato')
    expect(b.notification.body).toBe('Ritirato da front door in gate')
  })

  /**
   * A row enqueued before this field exists must drain with the words it was
   * written for — a durable outbox row waiting on an unreachable target does
   * not get to change its meaning while it waits.
   */
  it('leaves a pre-catalog package row on the detection default', async () => {
    const sent = await deliver(
      en(),
      makeEntry(
        {
          ruleName: 'Parcel delivery (entrance)',
          subject: { deviceId: 104, className: 'package', zones: [], timestamp: 1 },
        },
        { recordKind: 'package-event' },
      ),
    )
    expect(sent.notification.title).toBe('Parcel delivery (entrance)')
    expect(sent.notification.body).toBe('Package on front door')
  })
})
