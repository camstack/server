import { describe, expect, it } from 'vitest'
import { integrationDetailUrl, resolveSelectedInstanceId } from '../integration-instance-selection'

const instances = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]

describe('resolveSelectedInstanceId', () => {
  it('selects the first instance when the URL names none', () => {
    expect(resolveSelectedInstanceId(null, instances)).toBe('i1')
  })
  it('keeps the requested instance', () => {
    expect(resolveSelectedInstanceId('i3', instances)).toBe('i3')
  })
  it('falls back to the first when the requested id is gone', () => {
    expect(resolveSelectedInstanceId('gone', instances)).toBe('i1')
  })
  it('selects nothing when the addon has no instance', () => {
    expect(resolveSelectedInstanceId('i1', [])).toBeNull()
  })
})

describe('integrationDetailUrl', () => {
  it('names the addon, and the instance when given', () => {
    expect(integrationDetailUrl('provider-wyze', 'i1')).toBe(
      '/integrations/provider-wyze?instance=i1',
    )
    expect(integrationDetailUrl('provider-wyze')).toBe('/integrations/provider-wyze')
  })
})
