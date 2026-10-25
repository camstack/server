/**
 * D698 — a state summary may be sent as ONE ROW PER SECTION.
 *
 * `split: 'rule'` (absent) is the D647 behaviour: one row, one record id.
 * `split: 'section'`: every section with something to say — items, or an
 * UNAVAILABLE read — is its own row, record id
 * `state-summary:<ruleId>:<windowEndMs>:<sectionId>`, titled and worded by its
 * section. A section with nothing open sends nothing.
 */
import { DeviceType, NcRuleInputSchema, type NcRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceIdentity } from '../../device-directory.js'
import type { NcLivenessRow } from '../../liveness-ledger.js'
import { NcTextCatalog } from '../../text-catalog.js'
import enBundle from '../../texts/en.json' with { type: 'json' }
import itBundle from '../../texts/it.json' with { type: 'json' }
import { type NcStateSourcePorts, stateSources } from '../state-sources.js'
import { collectStateSummary, stateSummaryText } from '../state-summary.js'
import {
  NC_STATE_SUMMARY_SECTION_BODY_KEY,
  NC_STATE_SUMMARY_SECTION_TITLE_KEY,
  NC_STATE_SUMMARY_TITLE_KEY,
  stateSummarySectionOf,
  stateSummarySubjects,
  withSummaryBody,
} from '../state-summary-delivery.js'
import type { NcSystemStateRow } from '../system-state-ledger.js'

const NOW = Date.UTC(2026, 9, 1, 8, 0)
const WINDOW = { startMs: NOW - 60_000, endMs: NOW }

const DEVICES: Readonly<Record<number, NcDeviceIdentity>> = {
  20: { deviceId: 20, type: DeviceType.Camera, name: 'Front door', isCamera: true },
}

const OFFLINE: NcLivenessRow = {
  subject: 'device:20',
  state: 'offline',
  kind: 'device-offline',
  deviceId: 20,
  updatedAt: NOW - 3_600_000,
}

const STREAM: NcSystemStateRow = {
  key: 'stream:20',
  kind: 'stream-offline',
  since: NOW - 7_200_000,
  deviceId: 20,
  params: { profile: 'high' },
}

function ports(over: Partial<NcStateSourcePorts> = {}): NcStateSourcePorts {
  return {
    alerts: () => [],
    liveness: () => [OFFLINE],
    state: () => [STREAM],
    lookup: (id) => DEVICES[id],
    devicesAnswered: () => true,
    nodes: { complete: true, online: () => true },
    livenessHoldoffMs: 5 * 60_000,
    ...over,
  }
}

const RULE: NcRule = {
  ...NcRuleInputSchema.parse({
    name: 'Stato',
    delivery: 'system-event',
    conditions: {
      systemEvent: { kinds: ['device-offline', 'stream-offline', 'device-battery-low'] },
    },
    targets: [{ targetId: 't' }],
  }),
  id: 'rule-1',
  createdBy: 'admin',
  createdAt: 0,
  updatedAt: 0,
  enabled: true,
  disabledTargetIds: [],
}

function subjects(split: 'rule' | 'section', language: 'en' | 'it', over = {}) {
  const summary = collectStateSummary({
    rule: RULE,
    sources: stateSources(ports(over)),
    nowMs: NOW,
    isMuted: () => false,
  })
  const text = stateSummaryText({
    texts: new NcTextCatalog({ language }),
    summary,
    nowMs: NOW,
    timeZone: 'UTC',
  })
  return { text, rows: stateSummarySubjects({ rule: RULE, summary, text, window: WINDOW, split }) }
}

describe('state summary split (D698)', () => {
  it("split 'rule' is the D647 row: one subject, the window's record id", () => {
    const { rows, text } = subjects('rule', 'en')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.recordId).toBe(`state-summary:rule-1:${String(NOW)}`)
    expect(rows[0]?.systemEvent?.titleKey).toBe(NC_STATE_SUMMARY_TITLE_KEY)
    expect(rows[0]?.systemEvent?.textParams?.['summaryText']).toBe(text.text)
    expect(rows[0]?.systemEvent?.textParams?.['summarySection']).toBe(
      'Offline or off, Streams offline',
    )
  })

  it("split 'section': one row per section with something to say, each with its own record id", () => {
    const { rows } = subjects('section', 'en')
    expect(rows.map((row) => row.recordId)).toEqual([
      `state-summary:rule-1:${String(NOW)}:device-state`,
      `state-summary:rule-1:${String(NOW)}:streams`,
    ])
    // The battery section is read and EMPTY: it sends nothing.
    for (const row of rows) {
      expect(row.systemEvent?.titleKey).toBe(NC_STATE_SUMMARY_SECTION_TITLE_KEY)
      expect(row.systemEvent?.bodyKey).toBe(NC_STATE_SUMMARY_SECTION_BODY_KEY)
    }
  })

  it('each section row carries ONLY its section — words, count, and its own variable', () => {
    const { rows } = subjects('section', 'en')
    const devices = rows[0]?.systemEvent
    expect(devices?.textParams?.['summarySection']).toBe('Offline or off')
    // The body is the LINES: the row's title already names the section (review L3).
    expect(devices?.textParams?.['summaryText']).toBe('• Front door — offline (since 07:00 AM)')
    expect(devices?.textParams?.['summaryCount']).toBe('1')
    expect(devices?.textParams?.['summaryDevices']).toContain('Front door')
    expect(devices?.textParams?.['summaryStreams']).toBe('')
    expect(devices?.data['section']).toBe('device-state')
    expect(devices?.subject).toBe('state-summary:rule-1:device-state')
    const streams = rows[1]?.systemEvent
    expect(streams?.textParams?.['summaryText']).toContain('high stream offline')
    expect(streams?.textParams?.['summaryDevices']).toBe('')
  })

  it('an UNAVAILABLE section is its own row, worded exactly as the combined text says it', () => {
    const { rows, text } = subjects('section', 'en', { alerts: () => null })
    const battery = rows.find((row) => row.recordId.endsWith(':battery'))
    expect(battery?.systemEvent?.textParams?.['summaryText']).toBe(
      'Low batteries: unavailable — the state could not be read',
    )
    expect(text.text).toContain('Low batteries: unavailable — the state could not be read')
    expect(battery?.systemEvent?.textParams?.['summaryCount']).toBe('0')
  })

  it('nothing to say in any section sends no row at all', () => {
    const { rows } = subjects('section', 'en', { liveness: () => [], state: () => [] })
    expect(rows).toEqual([])
  })

  it('the section title and body are catalog keys, in EN and IT', () => {
    for (const bundle of [enBundle, itBundle]) {
      expect(Object.keys(bundle)).toEqual(
        expect.arrayContaining([
          NC_STATE_SUMMARY_SECTION_TITLE_KEY,
          NC_STATE_SUMMARY_SECTION_BODY_KEY,
        ]),
      )
    }
    const en = new NcTextCatalog({ language: 'en' })
    const it = new NcTextCatalog({ language: 'it' })
    const vars = { rule: 'Stato', summarySection: 'X', summaryText: 'Y', summaryCount: '3' }
    expect(en.text({ key: NC_STATE_SUMMARY_SECTION_TITLE_KEY, vars })).toBe('X: 3')
    expect(it.text({ key: NC_STATE_SUMMARY_SECTION_TITLE_KEY, vars })).toBe('X: 3')
    expect(en.text({ key: NC_STATE_SUMMARY_SECTION_BODY_KEY, vars })).toBe('Y')
    expect(it.text({ key: NC_STATE_SUMMARY_SECTION_BODY_KEY, vars })).toBe('Y')
    const { rows } = subjects('section', 'it')
    expect(rows[0]?.systemEvent?.textParams?.['summarySection']).toBe('Offline o spenti')
  })

  it('M3: a body naming only ONE section variable still carries every other section row', () => {
    const { rows } = subjects('section', 'en')
    const rule = { ...RULE, template: { body: 'Batterie: {{summaryBattery}}' } }
    const streams = rows.find((row) => row.recordId.endsWith(':streams'))
    if (streams === undefined) throw new Error('no streams row')
    expect(withSummaryBody(rule, stateSummarySectionOf(streams))?.template?.body).toBe(
      'Batterie: {{summaryBattery}}\n{{summaryText}}',
    )
    // …and the section it names is carried as written.
    expect(withSummaryBody(rule, 'battery')).toBeNull()
    expect(
      withSummaryBody({ ...RULE, template: { body: '{{summaryText}}' } }, 'streams'),
    ).toBeNull()
    // A combined row is judged as before: any summary variable carries it.
    expect(withSummaryBody(rule)).toBeNull()
  })
})
