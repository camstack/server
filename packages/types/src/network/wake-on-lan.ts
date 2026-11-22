/**
 * Wake-on-LAN: the pure part. Packet building and address arithmetic only, so
 * this file is safe in a browser bundle; the sender (a UDP socket) lives in
 * `wake-on-lan-node.ts`, exported from `@camstack/types/node`.
 */

export const WOL_PORT_DEFAULT = 9
export const WOL_REPEAT_DEFAULT = 3
export const WOL_REPEAT_GAP_MS = 100

const MAC_LENGTH = 6
const MAC_REPETITIONS = 16
const HEX_PAIR = /^[0-9a-fA-F]{12}$/

/** 'aa:bb:cc:dd:ee:ff', 'AA-BB-…', or 12 bare hex digits → 6 bytes; null when malformed,
 *  all-zero or the broadcast address. */
export function parseMacAddress(mac: string): Uint8Array | null {
  const digits = mac.trim().replace(/[:-]/g, '')
  if (!HEX_PAIR.test(digits)) return null
  // A separator is only legal between pairs: 'a:abbccddeeff' collapses to 12 digits.
  if (/[:-]/.test(mac) && !/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(mac.trim())) return null
  const bytes = new Uint8Array(MAC_LENGTH)
  for (let i = 0; i < MAC_LENGTH; i += 1) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  }
  if (bytes.every((b) => b === 0x00)) return null
  if (bytes.every((b) => b === 0xff)) return null
  return bytes
}

/** 6 × 0xFF, then the MAC 16 times (102 bytes); + the 6-byte SecureOn password when given (108). */
export function buildMagicPacket(mac: Uint8Array, secureOn?: Uint8Array): Uint8Array {
  const tail = secureOn ?? new Uint8Array(0)
  const packet = new Uint8Array(MAC_LENGTH + MAC_LENGTH * MAC_REPETITIONS + tail.length)
  packet.fill(0xff, 0, MAC_LENGTH)
  for (let i = 0; i < MAC_REPETITIONS; i += 1) {
    packet.set(mac, MAC_LENGTH + i * MAC_LENGTH)
  }
  packet.set(tail, MAC_LENGTH + MAC_LENGTH * MAC_REPETITIONS)
  return packet
}

/** Four decimal octets of a dotted IPv4 address as a uint32, or null when malformed. */
export function ipv4ToUint32(ipv4: string): number | null {
  const parts = ipv4.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function uint32ToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.')
}

/** '192.168.1.37', 24 → '192.168.1.255'; null when either is malformed or the prefix is /31, /32. */
export function directedBroadcastOf(ipv4: string, prefixLength: number): string | null {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 30) return null
  const address = ipv4ToUint32(ipv4)
  if (address === null) return null
  const hostBits = 32 - prefixLength
  const hostMask = hostBits === 32 ? 0xffffffff : (1 << hostBits) - 1
  return uint32ToIpv4((address | hostMask) >>> 0)
}
