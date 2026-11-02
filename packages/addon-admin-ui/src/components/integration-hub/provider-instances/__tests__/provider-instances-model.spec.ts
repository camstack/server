/**
 * The row model of the provider-instances panel: pure data in, rows and a three-state answer
 * out. An unanswered query is never an empty list (D315), and an edit sends only what changed.
 */
import { describe, expect, it } from 'vitest'
import {
  buildRows,
  creatableProviders,
  deriveState,
  diffInstanceValues,
  formatEditRef,
  mintInstanceId,
  parseEditRef,
  providersOf,
  targetsPinning,
  type HolderData,
} from '../provider-instances-model'

const SECRET_VIEW = { $secret: 'ref', v: 1, set: true }

const loki: HolderData = {
  addonId: 'loki-logging',
  description: { instanceMode: 'single', kind: 'destination', canTest: true },
  instances: [{ id: 'loki-logging', name: 'Loki', configured: true, formValues: {} }],
}
const smtp: HolderData = {
  addonId: 'smtp-nodemailer',
  description: { instanceMode: 'multiple', kind: 'relay', canTest: false },
  instances: [
    { id: 'relay-default', name: 'Default', configured: true, formValues: {} },
    {
      id: 'inst-aaaaaaaa',
      name: 'Office',
      configured: false,
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
      { id: 'a', name: 'On by default', configured: true, formValues: {} },
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

  it('a row without the field reads as enabled, an explicit false as off', () => {
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
