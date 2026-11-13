/**
 * The default TITLE of a sensor notification is the SENSOR's name — not the
 * rule's name (the old `detection.title` fall-through) and not the camera's
 * (`{{device}}` on a sensor row resolves to the linked camera).
 */
import { describe, expect, it } from 'vitest'
import { sensorOf } from '../appliance-cycle.js'
import { buildTemplateVars, renderRowTitle } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

const texts = new NcTextCatalog({ language: 'en' })
const AT = 1_753_000_000_000

function sensorRow(
  over: {
    readonly sensor?: { deviceId: number; name: string } | null
    readonly title?: string
    readonly applianceCycle?: boolean
  } = {},
): NcOutboxEntry {
  const sensor =
    over.sensor === undefined ? { deviceId: 5379, name: 'Porta ingresso' } : over.sensor
  return {
    id: 'rule-1:sns-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 3629,
    recordKind: 'device-event',
    recordId: 'sns-1',
    status: 'pending',
    attempts: 0,
    createdAt: AT,
    updatedAt: AT,
    nextAttemptAt: AT,
    payload: {
      ruleName: 'Apertura porte — mosaico camere',
      delivery: 'device-event',
      priority: 3,
      media: 'none',
      ...(over.title !== undefined ? { template: { title: over.title } } : {}),
      subject: {
        deviceId: 3629,
        className: 'contact',
        zones: [],
        timestamp: AT,
        ...(sensor !== null ? { sensor } : {}),
        ...(over.applianceCycle === true ? { applianceCycle: { deviceId: 5379 } } : {}),
      },
    },
  }
}

const vars = (e: NcOutboxEntry): Readonly<Record<string, string>> =>
  buildTemplateVars(texts, e, 'Camera ingresso', [])

describe('sensor row title', () => {
  it('is the sensor name, not the rule name nor the camera name', () => {
    const e = sensorRow()
    expect(renderRowTitle(texts, e, vars(e))).toBe('Porta ingresso')
  })
  it('an authored template title still wins, and {{sensor}} is declared', () => {
    const e = sensorRow({ title: 'Aperta: {{sensor}}' })
    expect(renderRowTitle(texts, e, vars(e))).toBe('Aperta: Porta ingresso')
  })
  it('an alarm intrusion title (D706) beats the sensor name', () => {
    const base = sensorRow()
    const e: NcOutboxEntry = {
      ...base,
      payload: { ...base.payload, alarmIntrusion: { locations: ['Hall'] } },
    }
    expect(renderRowTitle(texts, e, vars(e))).not.toBe('Porta ingresso')
    expect(renderRowTitle(texts, e, vars(e))).toContain('Hall')
  })
  it('a detection row is titled with the subject and the camera, not the rule', () => {
    const e = sensorRow({ sensor: null })
    expect(renderRowTitle(texts, e, vars(e))).toBe('Contact — Camera ingresso')
  })
  it('history renders the same title (one recipe, D708)', () => {
    const e = sensorRow()
    expect(renderRowTitle(texts, e, buildTemplateVars(texts, e, '', []))).toBe(
      renderRowTitle(texts, e, vars(e)),
    )
  })
})

describe('sensorOf (frozen at enqueue)', () => {
  const name = (id: number): string | undefined => (id === 5379 ? 'Porta ingresso' : undefined)
  it('a linked sensor row freezes the sensor, not the camera', () => {
    expect(
      sensorOf(
        { deviceId: 3629, sourceDeviceId: 5379, linkedSensorId: 5379, source: 'sensor' },
        name,
      ),
    ).toEqual({ sensor: { deviceId: 5379, name: 'Porta ingresso' } })
  })
  it('an unlinked sensor is its own subject (D630 §6)', () => {
    expect(sensorOf({ deviceId: 5379, source: 'sensor' }, name)).toEqual({
      sensor: { deviceId: 5379, name: 'Porta ingresso' },
    })
  })
  it('a detection, a nameless sensor and a finished appliance cycle freeze nothing', () => {
    expect(sensorOf({ deviceId: 3629, source: 'pipeline' }, name)).toEqual({})
    expect(sensorOf({ deviceId: 9, source: 'sensor' }, name)).toEqual({})
    expect(
      sensorOf(
        { deviceId: 5379, source: 'sensor', sensorKind: 'appliance-cycle', sensorRaised: false },
        name,
      ),
    ).toEqual({})
  })
})
