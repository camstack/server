import { describe, expect, it } from 'vitest'
import {
  integrationDetailUrl,
  parseInstanceIds,
  resolveDetailRoute,
  resolveSelectedInstanceIds,
} from '../integration-instance-selection'

const instances = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]

describe('resolveSelectedInstanceIds', () => {
  it('selects the first instance when the URL names none', () => {
    expect(resolveSelectedInstanceIds([], instances)).toEqual(['i1'])
  })
  it('keeps the requested instances in the addon order and drops unknown ids', () => {
    expect(resolveSelectedInstanceIds(['i3', 'gone', 'i1'], instances)).toEqual(['i1', 'i3'])
  })
  it('falls back to the first when every requested id is gone', () => {
    expect(resolveSelectedInstanceIds(['gone'], instances)).toEqual(['i1'])
  })
  it('selects nothing when the addon has no instance', () => {
    expect(resolveSelectedInstanceIds(['i1'], [])).toEqual([])
  })
})

describe('parseInstanceIds / integrationDetailUrl', () => {
  it('round-trips', () => {
    expect(parseInstanceIds('i1, i2,,')).toEqual(['i1', 'i2'])
    expect(parseInstanceIds(null)).toEqual([])
    expect(integrationDetailUrl('provider-wyze', ['i1', 'i2'])).toBe(
      '/integrations/provider-wyze?instances=i1,i2',
    )
    expect(integrationDetailUrl('provider-wyze')).toBe('/integrations/provider-wyze')
  })
})

describe('resolveDetailRoute', () => {
  const list = [{ id: 'int_1', addonId: 'provider-wyze' }]
  it('waits for the list', () => {
    expect(resolveDetailRoute('int_1', undefined)).toEqual({ kind: 'pending' })
  })
  it('redirects an old per-instance link to its addon with the instance selected', () => {
    expect(resolveDetailRoute('int_1', list)).toEqual({
      kind: 'redirect',
      to: '/integrations/provider-wyze?instances=int_1',
    })
  })
  it('treats anything else as an addon id', () => {
    expect(resolveDetailRoute('provider-wyze', list)).toEqual({
      kind: 'addon',
      addonId: 'provider-wyze',
    })
  })
})
