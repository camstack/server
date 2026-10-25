/**
 * `buildTemplateVars` — the SOUND and DEVICE-EVENT variables the catalog now
 * advertises (`sounds`, `hitPercent`, `db`, `eventType`), plus `{{time}}`
 * rendered in the notification language rather than the server's own locale.
 *
 * Kept separate from `dispatcher-texts.spec.ts` (which is about the RENDER
 * chain) because these are about the VARIABLE MAP itself: `buildTemplateVars`
 * is exported here so the map can be asserted directly, one key at a time.
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateVars } from '../dispatcher.js'
import { ncClockText } from '../clock-text.js'
import { NcTextCatalog } from '../text-catalog.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

function makeEntry(subjectOverrides: Partial<NcOutboxPayload['subject']> = {}): NcOutboxEntry {
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
        ...subjectOverrides,
      },
    },
  }
}

describe('buildTemplateVars — the new variables', () => {
  const texts = new NcTextCatalog({ language: 'it' })

  it('a sound row carries sounds, hitPercent and db', () => {
    const entry = makeEntry({
      className: 'audio-dog_bark',
      audio: { labels: ['dog_bark', 'car_horn'], hitPercent: 42.4, peakDbfs: -17.6 },
    })
    const vars = buildTemplateVars(texts, entry, 'Garden', [], 'UTC')
    expect(vars['sounds']).toBe('dog_bark, car_horn')
    expect(vars['hitPercent']).toBe('42')
    expect(vars['db']).toBe('-18')
  })

  it('a sensor row carries its event type', () => {
    const entry = makeEntry({ className: 'doorbell', eventType: 'press' })
    expect(buildTemplateVars(texts, entry, 'Front door', [], 'UTC')['eventType']).toBe('press')
  })

  it('rows without them render the three sound vars and eventType EMPTY', () => {
    const vars = buildTemplateVars(
      texts,
      makeEntry({ className: 'person' }),
      'Front door',
      [],
      'UTC',
    )
    expect([vars['sounds'], vars['hitPercent'], vars['db'], vars['eventType']]).toEqual([
      '',
      '',
      '',
      '',
    ])
  })

  it('exposes both the wire class and the EVENT_KIND_LABELS translation', () => {
    const vars = buildTemplateVars(
      texts,
      makeEntry({ className: 'animal', label: 'cat' }),
      'Garden',
      [],
      'UTC',
    )
    expect(vars['class']).toBe('animal')
    expect(vars['classLabel']).toBe('animale')
    expect(vars['label']).toBe('cat')
    expect(vars['subject']).toBe('gatto')
    expect(vars['camera']).toBe('garden')
  })

  it('time is HH:MM in the catalog language, not the server locale', () => {
    const at = Date.UTC(2026, 8, 24, 20, 5)
    const entry = makeEntry({ className: 'person', timestamp: at })
    expect(buildTemplateVars(texts, entry, 'Front door', [], 'UTC')['time']).toBe(
      ncClockText('it', at, 'UTC'),
    )
    expect(ncClockText('it', at, 'UTC')).toBe('20:05')
    expect(ncClockText('en', at, 'UTC')).toMatch(/^0?8:05\s?PM$/)
  })
})
