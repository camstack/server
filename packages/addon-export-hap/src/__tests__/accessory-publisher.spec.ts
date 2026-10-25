import { describe, it, expect } from 'vitest'
import { deriveUsername } from '../accessory-publisher.js'

describe('deriveUsername', () => {
  it('produces a valid uppercase MAC-format string', () => {
    const mac = deriveUsername('some-accessory-uuid')
    expect(mac).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/)
  })

  it('sets the locally-administered bit and clears the multicast bit', () => {
    const mac = deriveUsername('camstack:camera:42')
    const firstOctet = parseInt(mac.split(':')[0]!, 16)
    expect(firstOctet & 0x02).toBe(0x02) // locally administered
    expect(firstOctet & 0x01).toBe(0x00) // unicast (not multicast)
  })

  it('is deterministic for the same seed (pairing survives restarts)', () => {
    expect(deriveUsername('uuid-A')).toBe(deriveUsername('uuid-A'))
  })

  it('differs for different seeds (each accessory has a unique identity)', () => {
    expect(deriveUsername('uuid-A')).not.toBe(deriveUsername('uuid-B'))
  })
})
