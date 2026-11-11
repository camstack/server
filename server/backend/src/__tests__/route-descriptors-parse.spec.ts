import { describe, expect, it } from 'vitest'
import { parseSerializableRouteDescriptors } from '../core/addon/addon-registry.service.js'

describe('parseSerializableRouteDescriptors', () => {
  it('keeps the per-instance flag of a forked route, so the hub serves it under an instance segment', () => {
    const parsed = parseSerializableRouteDescriptors([
      { method: 'POST', path: '/directive', access: 'public', perInstance: true },
      { method: 'GET', path: '/health', access: 'public' },
      { method: 'GET', path: '/odd', access: 'public', perInstance: 'yes' },
    ])
    expect(parsed.map((r) => r.perInstance)).toEqual([true, undefined, undefined])
  })
})
