import { DEFAULT_SHARE_SOURCE, isAutomaticShareSource } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { probedDeviceSignature, shareTopologySignature } from '../load-balancing/share-inputs.js'
import type { LiveDeviceRow } from '../load-balancing/share-inputs.js'

const blob = {}
const row = (key: string, available = true, exclusion: string | null = null): LiveDeviceRow => ({
  key,
  available,
  exclusion,
})

describe('a fresh system balances by itself', () => {
  it('the default share source is the automatic one (benchmark)', () => {
    expect(DEFAULT_SHARE_SOURCE).toBe('benchmark')
    expect(isAutomaticShareSource(DEFAULT_SHARE_SOURCE)).toBe(true)
  })
})

describe('shareTopologySignature — the live device set (D750)', () => {
  it('changes when a device is hot-plugged with nothing stored for it', () => {
    const before = shareTopologySignature(['amd'], blob, { amd: [row('edgetpu:pci')] })
    const after = shareTopologySignature(['amd'], blob, {
      amd: [row('edgetpu:pci'), row('edgetpu:usb')],
    })
    expect(after).not.toBe(before)
  })

  it('changes when a device is unplugged, or becomes excluded', () => {
    const base = shareTopologySignature(['amd'], blob, { amd: [row('edgetpu:usb')] })
    expect(shareTopologySignature(['amd'], blob, { amd: [] })).not.toBe(base)
    expect(shareTopologySignature(['amd'], blob, { amd: [row('edgetpu:usb', false)] })).not.toBe(
      base,
    )
    expect(
      shareTopologySignature(['amd'], blob, { amd: [row('edgetpu:usb', true, 'disabled')] }),
    ).not.toBe(base)
  })

  it('a probe that gained, lost or flipped a device has another signature', () => {
    const one = [{ key: 'a', available: true }]
    expect(probedDeviceSignature(one)).toBe(probedDeviceSignature([...one]))
    expect(probedDeviceSignature([...one, { key: 'b', available: true }])).not.toBe(
      probedDeviceSignature(one),
    )
    expect(probedDeviceSignature([{ key: 'a', available: false }])).not.toBe(
      probedDeviceSignature(one),
    )
  })

  it('is stable for an unchanged live set, whatever the order it was read in', () => {
    const a = shareTopologySignature(['amd'], blob, { amd: [row('a'), row('b')] })
    const b = shareTopologySignature(['amd'], blob, { amd: [row('b'), row('a')] })
    expect(a).toBe(b)
  })
})
