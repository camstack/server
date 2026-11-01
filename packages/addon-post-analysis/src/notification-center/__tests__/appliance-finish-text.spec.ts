/**
 * The default sentence of an appliance that FINISHES its cycle: title and body
 * from the text catalog, duration and energy as separate, omit-when-unknown
 * parts read through ONE port (`NcResolveApplianceCycleFacts`).
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  applianceCycleOf,
  type NcApplianceCycleFacts,
  type NcResolveApplianceCycleFacts,
} from '../appliance-cycle.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

const FINISHED_AT = 1_753_000_000_000

function finishEntry(template?: { title?: string; body?: string }): NcOutboxEntry {
  return {
    id: 'r:1:t',
    ruleId: 'r',
    targetId: 't',
    deviceId: 7,
    recordKind: 'device-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      ruleName: 'Fine ciclo elettrodomestici',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      ...(template !== undefined ? { template } : {}),
      subject: {
        deviceId: 7,
        className: 'appliance-cycle',
        zones: [],
        timestamp: FINISHED_AT,
        applianceCycle: { deviceId: 7 },
      },
    },
  }
}

async function render(
  texts: NcTextCatalog,
  resolve: NcResolveApplianceCycleFacts | undefined,
  entry: NcOutboxEntry = finishEntry(),
): Promise<{ title: string; body: string }> {
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    texts,
    listTargets: async () => [
      { id: 't', addonId: 'notifiers', name: 'Phone', kind: 'pushover', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Lavatrice',
    getZoneNames: async () => [],
    ...(resolve !== undefined ? { resolveApplianceCycleFacts: resolve } : {}),
  })
  await dispatcher.deliver(entry)
  const sent = sends[0]
  if (sent === undefined) throw new Error('nothing was sent')
  return { title: sent.notification.title ?? '', body: sent.notification.body }
}

const facts =
  (value: NcApplianceCycleFacts): NcResolveApplianceCycleFacts =>
  async () =>
    value
const it_ = (): NcTextCatalog => new NcTextCatalog({ language: 'it' })

describe('appliance finish text', () => {
  it('names the duration and the energy, capitalised, in Italian', async () => {
    const out = await render(it_(), facts({ durationMs: 52 * 60_000, energyKwh: 0.84 }))
    expect(out.title).toBe('Lavatrice ha terminato')
    expect(out.body).toBe('Lavatrice ha terminato dopo 52 minuti e ha consumato 0,84 kWh')
  })

  it('English variant', async () => {
    const out = await render(
      new NcTextCatalog(),
      facts({ durationMs: 52 * 60_000, energyKwh: 0.84 }),
    )
    expect(out.title).toBe('Lavatrice finished')
    expect(out.body).toBe('Lavatrice finished after 52 minutes and used 0.84 kWh')
  })

  it('a device without a meter drops the energy part, no dangling conjunction', async () => {
    const out = await render(it_(), facts({ durationMs: 52 * 60_000, energyKwh: null }))
    expect(out.body).toBe('Lavatrice ha terminato dopo 52 minuti')
  })

  it('an unknown start drops the duration part only', async () => {
    const out = await render(it_(), facts({ durationMs: null, energyKwh: 0.84 }))
    expect(out.body).toBe('Lavatrice ha terminato e ha consumato 0,84 kWh')
  })

  it('a failing lookup still sends the bare sentence', async () => {
    const out = await render(it_(), async () => {
      throw new Error('boom')
    })
    expect(out.body).toBe('Lavatrice ha terminato')
  })

  it('no port wired still sends the bare sentence', async () => {
    expect((await render(it_(), undefined)).body).toBe('Lavatrice ha terminato')
  })

  it('renders hours from 60 minutes and never "0 minutes"', async () => {
    expect((await render(it_(), facts({ durationMs: 72 * 60_000, energyKwh: null }))).body).toBe(
      'Lavatrice ha terminato dopo 1 h 12 min',
    )
    expect((await render(it_(), facts({ durationMs: 10_000, energyKwh: null }))).body).toBe(
      'Lavatrice ha terminato',
    )
  })

  it('an operator override of the energy fragment is used', async () => {
    const texts = new NcTextCatalog({
      language: 'it',
      overrides: { it: { 'appliance.finished.energy': ' ({{energy}})' } },
    })
    const out = await render(texts, facts({ durationMs: 52 * 60_000, energyKwh: 0.84 }))
    expect(out.body).toBe('Lavatrice ha terminato dopo 52 minuti (0,84 kWh)')
  })

  it('a rule template still wins and can place {{duration}} and {{energy}}', async () => {
    const out = await render(
      it_(),
      facts({ durationMs: 52 * 60_000, energyKwh: 0.84 }),
      finishEntry({ title: '{{device}}', body: '{{duration}} / {{energy}}' }),
    )
    expect(out.title).toBe('lavatrice')
    expect(out.body).toBe('52 minuti / 0,84 kWh')
  })
})

describe('applianceCycleOf', () => {
  it('marks only the finish of an appliance cycle, on the sensor itself', () => {
    const base = { deviceId: 3, sourceDeviceId: 9, sensorKind: 'appliance-cycle' }
    expect(applianceCycleOf({ ...base, sensorRaised: false })).toEqual({
      applianceCycle: { deviceId: 9 },
    })
    expect(applianceCycleOf({ ...base, sensorRaised: true })).toEqual({})
    expect(applianceCycleOf({ ...base, sensorKind: 'flood', sensorRaised: false })).toEqual({})
  })
})
