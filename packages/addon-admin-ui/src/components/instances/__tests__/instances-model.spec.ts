/**
 * The row model of the instances table: pure data in, rows and a three-state answer
 * out. An unanswered query is never an empty list (D315), and an edit sends only what changed.
 */
import { describe, expect, it } from 'vitest'
import {
  buildRows,
  creatableProviders,
  deriveState,
  diffInstanceValues,
  filterRows,
  formatEditRef,
  mintInstanceId,
  parseEditRef,
  providerPills,
  rowHealth,
  worstHealth,
  type InstanceRow,
  providersOf,
  targetsPinning,
  type HolderData,
} from '../instances-model'

const SECRET_VIEW = { $secret: 'ref', v: 1, set: true }

const loki: HolderData = {
  addonId: 'loki-logging',
  description: { instanceMode: 'single', kind: 'destination', canTest: true },
  instances: [
    { id: 'loki-logging', name: 'Loki', configured: true, enabled: true, formValues: {} },
  ],
}
const smtp: HolderData = {
  addonId: 'smtp-nodemailer',
  description: { instanceMode: 'multiple', kind: 'relay', canTest: false },
  instances: [
    { id: 'relay-default', name: 'Default', configured: true, enabled: true, formValues: {} },
    {
      id: 'inst-aaaaaaaa',
      name: 'Office',
      configured: false,
      enabled: true,
      formValues: {},
      status: { state: 'error', detail: 'refused' },
    },
  ],
}

const names = new Map([
  ['winston-logging', 'Winston'],
  ['loki-logging', 'Loki'],
  ['smtp-nodemailer', 'SMTP'],
])
const descriptions = new Map([['winston-logging', 'Rotated files']])

describe('buildRows', () => {
  it('merges instance rows of instance-holding providers with fixed rows of the others', () => {
    const rows = buildRows({
      functionProviders: [
        { addonId: 'winston-logging', isActive: true },
        { addonId: 'loki-logging', isActive: true },
      ],
      holders: [loki],
      displayNames: names,
      descriptions,
    })
    expect(rows.map((r) => [r.kind, r.addonId, r.kind === 'instance' ? r.id : null])).toEqual([
      ['fixed', 'winston-logging', null],
      ['instance', 'loki-logging', 'loki-logging'],
    ])
    expect(rows[0]).toMatchObject({
      providerName: 'Winston',
      description: 'Rotated files',
    })
  })

  it('makes one row per instance and keeps the provider status and canTest', () => {
    const rows = buildRows({
      functionProviders: [{ addonId: 'smtp-nodemailer', isActive: true }],
      holders: [smtp],
      displayNames: names,
      descriptions,
    })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      kind: 'instance',
      id: 'inst-aaaaaaaa',
      configured: false,
      canTest: false,
      status: { state: 'error', detail: 'refused' },
    })
  })

  it('ignores a holder that does not provide the function cap', () => {
    const rows = buildRows({
      functionProviders: [{ addonId: 'winston-logging', isActive: true }],
      holders: [loki],
      displayNames: names,
      descriptions,
    })
    expect(rows.map((r) => r.addonId)).toEqual(['winston-logging'])
  })
})

describe('creatableProviders', () => {
  it('offers multiple-mode holders, and single-mode ones with no record yet', () => {
    const emptyLoki: HolderData = { ...loki, instances: [] }
    expect(creatableProviders([loki, smtp]).map((h) => h.addonId)).toEqual(['smtp-nodemailer'])
    expect(creatableProviders([emptyLoki, smtp]).map((h) => h.addonId)).toEqual([
      'loki-logging',
      'smtp-nodemailer',
    ])
  })
})

describe('deriveState', () => {
  it('is pending while any query is unanswered, never ready with an empty list', () => {
    expect(
      deriveState([
        { isPending: false, isError: false },
        { isPending: true, isError: false },
      ]),
    ).toBe('pending')
  })
  it('is error when any query failed, even if another is pending', () => {
    expect(
      deriveState([
        { isPending: true, isError: false },
        { isPending: false, isError: true },
      ]),
    ).toBe('error')
  })
  it('is ready only when every query answered', () => {
    expect(deriveState([{ isPending: false, isError: false }])).toBe('ready')
  })
})

describe('diffInstanceValues', () => {
  it('omits untouched keys, so a stored secret view is never sent', () => {
    const stored = { host: 'a', password: SECRET_VIEW }
    expect(diffInstanceValues(stored, { host: 'a', password: SECRET_VIEW })).toEqual({})
  })
  it('keeps typed, changed and cleared keys', () => {
    const stored = { host: 'a', port: 25, password: SECRET_VIEW }
    const clear = { $secretClear: true }
    expect(diffInstanceValues(stored, { host: 'b', port: 25, password: 'typed' })).toEqual({
      host: 'b',
      password: 'typed',
    })
    expect(diffInstanceValues(stored, { ...stored, password: clear })).toEqual({
      password: clear,
    })
  })
  it('treats a key absent from the stored values as changed when it has a value', () => {
    expect(diffInstanceValues({}, { host: 'x', note: undefined })).toEqual({
      host: 'x',
    })
  })
})

describe('mintInstanceId', () => {
  it('single mode uses the addon id', () => {
    expect(mintInstanceId('single', 'loki-logging', () => 'deadbeef')).toBe('loki-logging')
  })
  it('multiple mode mints an opaque inst- id', () => {
    expect(mintInstanceId('multiple', 'smtp-nodemailer', () => 'deadbeef')).toBe('inst-deadbeef')
  })
})

describe('edit refs', () => {
  it('round-trips an instance, a create and a fixed row', () => {
    for (const [addonId, id] of [
      ['smtp-nodemailer', 'inst-aaaaaaaa'],
      ['smtp-nodemailer', null],
      ['winston-logging', undefined],
    ] as const) {
      const ref = formatEditRef(addonId, id)
      expect(parseEditRef(ref)).toEqual(
        id === undefined
          ? { kind: 'fixed', addonId }
          : id === null
            ? { kind: 'create', addonId }
            : { kind: 'instance', addonId, id },
      )
    }
  })
  it('keeps a colon inside an instance id', () => {
    expect(parseEditRef('a:b:c')).toEqual({ kind: 'instance', addonId: 'a', id: 'b:c' })
  })
})

describe('targetsPinning', () => {
  it('names the targets that pin the instance and no others', () => {
    const targets = [
      { name: 'Mail ops', config: { smtpInstanceId: 'inst-aaaaaaaa' } },
      { name: 'Mail default', config: {} },
      { name: 'Mail other', config: { smtpInstanceId: 'relay-default' } },
    ]
    expect(targetsPinning(targets, 'inst-aaaaaaaa')).toEqual(['Mail ops'])
  })
})

describe('enabled and providersOf', () => {
  const off: HolderData = {
    ...smtp,
    instances: [
      { id: 'a', name: 'Switched on', configured: true, enabled: true, formValues: {} },
      { id: 'b', name: 'Switched off', configured: true, formValues: {}, enabled: false },
    ],
  }
  const rows = buildRows({
    functionProviders: [
      { addonId: 'loki-logging', isActive: true },
      { addonId: 'smtp-nodemailer', isActive: true },
    ],
    holders: [loki, off],
    displayNames: names,
    descriptions,
  })

  it('a row follows the flag of its record, on or off', () => {
    const flags = rows.flatMap((r) => (r.kind === 'instance' ? [[r.id, r.enabled]] : []))
    expect(flags).toEqual([
      ['loki-logging', true],
      ['a', true],
      ['b', false],
    ])
  })

  it('names each provider once, in row order', () => {
    expect(providersOf(rows)).toEqual([
      { addonId: 'loki-logging', name: 'Loki' },
      { addonId: 'smtp-nodemailer', name: 'SMTP' },
    ])
    expect(providersOf([])).toEqual([])
  })
})

describe('add stays offered (instanceMode)', () => {
  const many = (n: number): HolderData => ({
    addonId: 'm',
    description: { instanceMode: 'multiple', kind: 'x', canTest: false },
    instances: Array.from({ length: n }, (_, i) => ({
      id: `i${i}`,
      name: `N${i}`,
      configured: true,
      enabled: true,
      formValues: {},
    })),
  })
  it('a multiple provider is creatable with 0, 1 and 5 rows', () => {
    for (const n of [0, 1, 5]) expect(creatableProviders([many(n)])).toHaveLength(1)
  })
  it('a single provider is creatable only while it has no row', () => {
    const single = (n: number): HolderData => ({
      ...many(n),
      description: { instanceMode: 'single', kind: 'x', canTest: false },
    })
    expect(creatableProviders([single(0)])).toHaveLength(1)
    expect(creatableProviders([single(1)])).toHaveLength(0)
    expect(creatableProviders([single(3)])).toHaveLength(0)
  })
})

describe('pills and filter', () => {
  const names = new Map([['smtp-nodemailer', 'SMTP']])
  const rows = buildRows({
    functionProviders: [
      { addonId: 'loki-logging', isActive: true },
      { addonId: 'smtp-nodemailer', isActive: true },
      { addonId: 'console', isActive: true },
    ],
    holders: [loki, smtp],
    displayNames: names,
    descriptions: new Map(),
  })

  it('counts instances per holder and reports the worst status', () => {
    const pills = providerPills([loki, smtp], rows, names)
    expect(pills.map((p) => [p.addonId, p.name, p.count, p.health])).toEqual([
      ['loki-logging', 'loki-logging', 1, 'ok'],
      ['smtp-nodemailer', 'SMTP', 2, 'error'],
    ])
  })

  it('a holder with no record keeps a pill with count 0 and an unknown dot', () => {
    const empty: HolderData = { ...smtp, instances: [] }
    expect(providerPills([empty], [], names)[0]).toMatchObject({ count: 0, health: 'unknown' })
  })

  it('an off row is off, an unconfigured one unknown, and error outranks ok', () => {
    const base = rows.find((r): r is InstanceRow => r.kind === 'instance')!
    const off = { ...base, enabled: false }
    const ok = { ...base, status: undefined, configured: true }
    const bad = { ...base, status: { state: 'error' as const } }
    expect(rowHealth(off)).toBe('off')
    expect(rowHealth({ ...ok, configured: false })).toBe('unknown')
    expect(worstHealth([ok, off])).toBe('ok')
    expect(worstHealth([ok, bad])).toBe('error')
  })

  it('"All" (null) keeps every row, a pill keeps only its provider, fixed rows included under All', () => {
    expect(filterRows(rows, null)).toHaveLength(rows.length)
    expect(filterRows(rows, 'smtp-nodemailer').map((r) => r.addonId)).toEqual([
      'smtp-nodemailer',
      'smtp-nodemailer',
    ])
    expect(filterRows(rows, 'console').map((r) => r.kind)).toEqual(['fixed'])
  })
})
