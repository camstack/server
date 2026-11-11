/**
 * The row model of the instances table: pure data in, rows and a three-state answer
 * out. An unanswered query is never an empty list (D315), and an edit sends only what changed.
 */
import { describe, expect, it } from 'vitest'
import {
  addonDescriptions,
  providerNamesByAddon,
  formStartValues,
  isStoppedProcessState,
  effectiveInstanceValues,
  buildRows,
  creatableProviders,
  deriveState,
  diffInstanceValues,
  filterRows,
  formatEditRef,
  findKind,
  mintInstanceId,
  needsKindPicker,
  statusText,
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
  description: {
    role: 'services',
    instanceMode: 'single',
    kind: 'destination',
    canTest: true,
    kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
  },
  instances: [
    {
      id: 'loki-logging',
      name: 'Loki',
      configured: true,
      enabled: true,
      formValues: {},
      kind: 'k',
    },
  ],
}
const smtp: HolderData = {
  addonId: 'smtp-nodemailer',
  description: {
    role: 'services',
    instanceMode: 'multiple',
    kind: 'relay',
    canTest: false,
    kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
  },
  instances: [
    {
      id: 'relay-default',
      name: 'Default',
      configured: true,
      enabled: true,
      formValues: {},
      kind: 'k',
    },
    {
      id: 'inst-aaaaaaaa',
      name: 'Office',
      configured: false,
      enabled: true,
      formValues: {},
      kind: 'k',
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
    expect(parseEditRef('a:b:c')).toEqual({
      kind: 'instance',
      addonId: 'a',
      id: 'b:c',
    })
  })
})

describe('targetsPinning', () => {
  it('names the targets that pin the instance and no others', () => {
    const targets = [
      { name: 'Mail ops', formValues: { smtpInstanceId: 'inst-aaaaaaaa' } },
      { name: 'Mail default', formValues: {} },
      { name: 'Mail other', formValues: { smtpInstanceId: 'relay-default' } },
    ]
    expect(targetsPinning(targets, 'inst-aaaaaaaa')).toEqual(['Mail ops'])
  })
})

describe('enabled and providersOf', () => {
  const off: HolderData = {
    ...smtp,
    instances: [
      {
        id: 'a',
        name: 'Switched on',
        configured: true,
        enabled: true,
        formValues: {},
        kind: 'k',
      },
      {
        id: 'b',
        name: 'Switched off',
        configured: true,
        formValues: {},
        kind: 'k',
        enabled: false,
      },
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
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'x',
      canTest: false,
      kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
    },
    instances: Array.from({ length: n }, (_, i) => ({
      id: `i${i}`,
      name: `N${i}`,
      configured: true,
      enabled: true,
      formValues: {},
      kind: 'k',
    })),
  })
  it('a multiple provider is creatable with 0, 1 and 5 rows', () => {
    for (const n of [0, 1, 5]) expect(creatableProviders([many(n)])).toHaveLength(1)
  })
  it('a single provider is creatable only while it has no row', () => {
    const single = (n: number): HolderData => ({
      ...many(n),
      description: {
        role: 'services',
        instanceMode: 'single',
        kind: 'x',
        canTest: false,
        kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
      },
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

  const fnProviders = [
    { addonId: 'loki-logging', isActive: true },
    { addonId: 'smtp-nodemailer', isActive: true },
    { addonId: 'console', isActive: true },
    { addonId: 'empty-holder', isActive: true },
  ]

  it('has a pill for EVERY provider: holders count instances, fixed rows count 1 with the registry dot', () => {
    const pills = providerPills(fnProviders, rows, names)
    expect(pills.map((p) => [p.addonId, p.name, p.count, p.health])).toEqual([
      ['loki-logging', 'loki-logging', 1, 'ok'],
      ['smtp-nodemailer', 'SMTP', 2, 'error'],
      ['console', 'console', 1, 'ok'],
      ['empty-holder', 'empty-holder', 0, 'unknown'],
    ])
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

describe('kinds, status label and last check', () => {
  const kinds: HolderData = {
    addonId: 'notifier',
    description: {
      role: 'services' as const,
      instanceMode: 'multiple',
      kind: 'target',
      canTest: true,
      kinds: [
        { id: 'a', label: 'Adapter A', functionCap: 'broker' },
        {
          id: 'b',
          label: 'Adapter B',
          functionCap: 'broker',
          connectPath: '/c/{{brokerId}}',
          disconnectPath: '/d/{{brokerId}}',
        },
      ],
    },
    instances: [
      {
        id: 'i1',
        name: 'One',
        configured: true,
        enabled: true,
        formValues: {},
        kind: 'b',
        status: { state: 'ok', label: 'Signed in' },
        lastCheckedAt: 7,
      },
    ],
  }

  it('a row carries its kind label, link paths and last check', () => {
    const [row] = buildRows({
      functionProviders: [{ addonId: 'notifier', isActive: true }],
      holders: [kinds],
      displayNames: new Map(),
      descriptions: new Map(),
    })
    expect(row).toMatchObject({
      kindId: 'b',
      kindLabel: 'Adapter B',
      connectPath: '/c/{{brokerId}}',
      disconnectPath: '/d/{{brokerId}}',
      lastCheckedAt: 7,
    })
  })

  it('asks for a kind only when there is a choice', () => {
    expect(needsKindPicker(kinds.description)).toBe(true)
    expect(needsKindPicker(smtp.description)).toBe(false)
    expect(
      needsKindPicker({
        ...smtp.description,
        kinds: [{ id: 'a', label: 'A', functionCap: 'broker' }],
      }),
    ).toBe(false)
    expect(findKind(kinds.description, 'a')?.label).toBe('Adapter A')
    expect(findKind(kinds.description, undefined)).toBeUndefined()
  })

  it('shows the label when the provider gave one, else the state', () => {
    expect(statusText({ state: 'ok', label: 'Signed in' })).toBe('Signed in')
    expect(statusText({ state: 'error' })).toBe('error')
  })
})

describe('effectiveInstanceValues', () => {
  it('overlays the edits on the stored record, keeping what was left alone', () => {
    expect(
      effectiveInstanceValues(
        { amazonDomain: 'amazon.it', pollIntervalMs: 60_000 },
        { pollIntervalMs: 15_000 },
      ),
    ).toEqual({ amazonDomain: 'amazon.it', pollIntervalMs: 15_000 })
  })
})

describe('formStartValues', () => {
  const body = { url: 'x', enabled: true }

  it('drops the record switch from the form values', () => {
    expect(formStartValues(body)).toEqual({ url: 'x' })
    expect(
      formStartValues(body, {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [{ type: 'text', key: 'url', label: 'Url' }],
          },
        ],
      }),
    ).toEqual({ url: 'x' })
  })

  it('keeps a value the form owns as a field named like the switch', () => {
    expect(
      formStartValues(body, {
        sections: [
          {
            id: 's',
            title: 'S',
            fields: [{ type: 'boolean', key: 'enabled', label: 'Enabled' }],
          },
        ],
      }),
    ).toEqual(body)
  })
})

describe('addon labels read from addons.list', () => {
  it('prefers the addon name over the package name: one package ships several addons', () => {
    const names = providerNamesByAddon([
      {
        manifest: {
          id: 'cloudflare-tunnel',
          name: 'Cloudflare Tunnel',
          packageDisplayName: 'Cloudflare',
        },
      },
      {
        manifest: {
          id: 'cloudflare-turn',
          name: 'Cloudflare TURN',
          packageDisplayName: 'Cloudflare',
        },
      },
    ])
    expect(names.get('cloudflare-tunnel')).toBe('Cloudflare Tunnel')
    expect(names.get('cloudflare-turn')).toBe('Cloudflare TURN')
  })

  it('falls back to the package name, then the id', () => {
    const names = providerNamesByAddon([
      { manifest: { id: 'a', packageDisplayName: 'Pkg A' } },
      { manifest: { id: 'b' } },
    ])
    expect(names.get('a')).toBe('Pkg A')
    expect(names.get('b')).toBe('b')
  })

  it('skips rows that are not an addon', () => {
    expect(providerNamesByAddon([null, {}, { manifest: {} }, 42, 'nope']).size).toBe(0)
    expect(addonDescriptions([null, {}, { manifest: { id: 'a' } }, 42]).size).toBe(0)
  })

  it('keeps a non-empty manifest description by addon id', () => {
    const descriptions = addonDescriptions([
      { manifest: { id: 'a', description: 'Sends mail' } },
      { manifest: { id: 'b', description: '' } },
    ])
    expect(descriptions.get('a')).toBe('Sends mail')
    expect(descriptions.has('b')).toBe(false)
  })
})

describe('isStoppedProcessState', () => {
  it('is true only for an answered state that is not running', () => {
    expect(isStoppedProcessState('failed')).toBe(true)
    expect(isStoppedProcessState('stopped')).toBe(true)
    expect(isStoppedProcessState('running')).toBe(false)
    expect(isStoppedProcessState('unknown')).toBe(false)
    expect(isStoppedProcessState(undefined)).toBe(false)
  })
})
