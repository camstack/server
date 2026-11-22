import { describe, expect, it } from 'vitest'
import { buildMagicPacket, directedBroadcastOf, parseMacAddress } from '../wake-on-lan.js'

const MAC_BYTES = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]

describe('parseMacAddress', () => {
  it('parses colon, dash and bare spellings to the same bytes', () => {
    expect(Array.from(parseMacAddress('aa:bb:cc:dd:ee:ff') ?? [])).toEqual(MAC_BYTES)
    expect(Array.from(parseMacAddress('AA-BB-CC-DD-EE-FF') ?? [])).toEqual(MAC_BYTES)
    expect(Array.from(parseMacAddress('aabbccddeeff') ?? [])).toEqual(MAC_BYTES)
  })

  it('refuses malformed, all-zero and broadcast addresses', () => {
    expect(parseMacAddress('')).toBeNull()
    expect(parseMacAddress('aa:bb:cc:dd:ee')).toBeNull()
    expect(parseMacAddress('aa:bb:cc:dd:ee:gg')).toBeNull()
    expect(parseMacAddress('aa:bb:cc:dd:ee:ff:00')).toBeNull()
    expect(parseMacAddress('00:00:00:00:00:00')).toBeNull()
    expect(parseMacAddress('ff:ff:ff:ff:ff:ff')).toBeNull()
  })
})

describe('buildMagicPacket', () => {
  const mac = new Uint8Array(MAC_BYTES)

  it('is 102 bytes: 6 x 0xFF then the MAC 16 times', () => {
    const packet = buildMagicPacket(mac)
    expect(packet.length).toBe(102)
    expect(Array.from(packet.subarray(0, 6))).toEqual([255, 255, 255, 255, 255, 255])
    for (let i = 0; i < 16; i += 1) {
      const start = 6 + i * 6
      expect(Array.from(packet.subarray(start, start + 6))).toEqual(MAC_BYTES)
    }
  })

  it('appends the 6-byte SecureOn password when given (108 bytes)', () => {
    const secure = new Uint8Array([1, 2, 3, 4, 5, 6])
    const packet = buildMagicPacket(mac, secure)
    expect(packet.length).toBe(108)
    expect(Array.from(packet.subarray(102))).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('directedBroadcastOf', () => {
  it('derives the directed broadcast for /24, /16 and /23', () => {
    expect(directedBroadcastOf('192.168.1.37', 24)).toBe('192.168.1.255')
    expect(directedBroadcastOf('10.20.30.40', 16)).toBe('10.20.255.255')
    expect(directedBroadcastOf('192.168.5.9', 23)).toBe('192.168.5.255')
    expect(directedBroadcastOf('192.168.4.9', 23)).toBe('192.168.5.255')
  })

  it('refuses /31, /32, a malformed address and a malformed prefix', () => {
    expect(directedBroadcastOf('192.168.1.37', 31)).toBeNull()
    expect(directedBroadcastOf('192.168.1.37', 32)).toBeNull()
    expect(directedBroadcastOf('not-an-ip', 24)).toBeNull()
    expect(directedBroadcastOf('192.168.1.300', 24)).toBeNull()
    expect(directedBroadcastOf('192.168.1.37', -1)).toBeNull()
    expect(directedBroadcastOf('192.168.1.37', 24.5)).toBeNull()
  })
})
