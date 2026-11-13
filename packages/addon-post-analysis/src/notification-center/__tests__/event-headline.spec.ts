/**
 * A detection's default title names the subject and the place, never the rule.
 *
 * The rule name stays available as `{{rule}}` for an operator template and for
 * a hub Texts override; only the shipped `detection.title` changes.
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateVars, renderRowTitle } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

const AT = 1_753_000_000_000

function row(
  subject: NcOutboxPayload['subject'],
  over: { readonly recordKind?: NcOutboxEntry['recordKind']; readonly title?: string } = {},
): NcOutboxEntry {
  return {
    id: 'rule-1:ev-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: subject.deviceId,
    recordKind: over.recordKind ?? 'object-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    createdAt: AT,
    updatedAt: AT,
    nextAttemptAt: AT,
    payload: {
      ruleName: 'Persona su Uscio',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      ...(over.title !== undefined ? { template: { title: over.title } } : {}),
      subject,
    },
  }
}

function title(
  texts: NcTextCatalog,
  entry: NcOutboxEntry,
  deviceName: string,
  zoneLabels: readonly string[] = [],
): string {
  return renderRowTitle(texts, entry, buildTemplateVars(texts, entry, deviceName, zoneLabels))
}

describe('detection default title', () => {
  const itTexts = new NcTextCatalog({ language: 'it' })
  const enTexts = new NcTextCatalog({ language: 'en' })

  it('is the class and the device when the event has no zone', () => {
    const entry = row({ deviceId: 4, className: 'person', zones: [], timestamp: AT })
    expect(title(enTexts, entry, 'Front door')).toBe('Person — Front door')
    expect(title(itTexts, entry, 'Uscio')).toBe('Persona — Uscio')
  })

  it('prefers a classification label over the coarse class, and a zone over the device', () => {
    const entry = row({
      deviceId: 4,
      className: 'animal',
      label: 'dog',
      zones: ['z-aiuola'],
      timestamp: AT,
    })
    expect(title(itTexts, entry, 'Giardino', ['Aiuola'])).toBe('Cane — Aiuola')
    expect(title(enTexts, entry, 'Garden', ['Flower bed'])).toBe('Dog — Flower bed')
  })

  it('keeps a person name as recognised', () => {
    const entry = row({
      deviceId: 4,
      className: 'person',
      label: 'Gianluca',
      labelKind: 'identity',
      zones: ['z1'],
      timestamp: AT,
    })
    expect(title(itTexts, entry, 'Uscio', ['Uscio'])).toBe('Gianluca — Uscio')
  })

  it('is the subject alone when there is no device and no zone', () => {
    const entry = row({ deviceId: 0, className: 'person', zones: [], timestamp: AT })
    expect(title(enTexts, entry, '')).toBe('Person')
    expect(title(itTexts, entry, 'system')).toBe('Persona')
  })

  it('a track-end and an occupancy row share that summary, not the rule name', () => {
    const ended = row(
      { deviceId: 4, className: 'person', zones: [], timestamp: AT },
      { recordKind: 'track-end' },
    )
    expect(title(enTexts, ended, 'Front door')).toBe('Person — Front door')
    const occupied = row({
      deviceId: 4,
      className: 'person',
      zones: [],
      timestamp: AT,
      occupancy: { zone: 'Aiuola', count: 1, capacity: 2, occupied: true },
    })
    expect(title(itTexts, occupied, 'Giardino')).toBe('Persona — Aiuola')
    expect(title(itTexts, occupied, 'Giardino')).not.toContain('Persona su Uscio')
  })

  it('an operator title and only an operator title still wins', () => {
    const entry = row(
      { deviceId: 4, className: 'person', zones: [], timestamp: AT },
      { title: '{{rule}}' },
    )
    expect(title(itTexts, entry, 'Uscio')).toBe('Persona su Uscio')
  })
})
