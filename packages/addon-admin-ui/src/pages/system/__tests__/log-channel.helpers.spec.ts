import { describe, expect, it } from 'vitest'
import type { LogChannelDescriptor } from '@dominevo/types'
import { addonOfChannel, groupChannelsByAddon, formatRemaining } from '../log-watch.helpers'

function channel(name: string, kind: 'diagnostic' | 'debug'): LogChannelDescriptor {
  return { name, description: 'd', defaultLevel: 'info', perDevice: true, kind }
}

describe('addonOfChannel', () => {
  it('is the part of the channel name before the first dot', () => {
    expect(addonOfChannel('stream-broker.webrtc')).toBe('stream-broker')
    expect(addonOfChannel('debug.reolink-events')).toBe('debug')
  })

  it('is the whole name when there is no dot', () => {
    expect(addonOfChannel('request-census')).toBe('request-census')
  })
})

describe('groupChannelsByAddon', () => {
  it('puts diagnostic and debug channels of one addon in ONE group, sorted by addon then name', () => {
    const groups = groupChannelsByAddon([
      channel('stream-broker.rtp', 'debug'),
      channel('provider-reolink.baichuan', 'diagnostic'),
      channel('stream-broker.webrtc', 'diagnostic'),
    ])
    expect(groups.map((g) => g.addon)).toEqual(['provider-reolink', 'stream-broker'])
    expect(groups[1]?.channels.map((c) => c.name)).toEqual([
      'stream-broker.rtp',
      'stream-broker.webrtc',
    ])
  })

  it('returns no group for no channels', () => {
    expect(groupChannelsByAddon([])).toEqual([])
  })
})

describe('formatRemaining', () => {
  it('reads as a deadline, never a bare millisecond count', () => {
    expect(formatRemaining(252_000)).toBe('4m 12s')
    expect(formatRemaining(45_000)).toBe('45s')
  })
})
