import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import {
  buildMagicPacket,
  directedBroadcastOf,
  ipv4ToUint32,
  parseMacAddress,
  WOL_PORT_DEFAULT,
  WOL_REPEAT_DEFAULT,
  WOL_REPEAT_GAP_MS,
} from './wake-on-lan.js'

export const WOL_REFUSAL_REASONS = [
  'invalid-mac', // parseMacAddress answered null
  'invalid-secure-on', // a SecureOn password that is not 6 bytes
  'invalid-broadcast-address', // a caller-supplied target that is not an IPv4 address
  'no-broadcast-interface', // no target given and the node has no non-internal IPv4 interface
  'send-failed', // every send errored (EACCES, ENETUNREACH, EPERM) — `detail` carries the codes
] as const
export type WakeOnLanRefusal = (typeof WOL_REFUSAL_REASONS)[number]

const WOL_REPEAT_MAX = 10
const LIMITED_BROADCAST = '255.255.255.255'
const SECURE_ON_HEX = /^[0-9a-fA-F]{12}$/

export interface WakeOnLanRequest {
  readonly mac: string
  /** Where to send. Absent = the directed broadcast of every non-internal IPv4 interface
   *  of THIS node, plus 255.255.255.255. */
  readonly broadcastAddresses?: readonly string[]
  /** Default 9. */
  readonly port?: number
  /** Datagrams per target, default 3, 1..10. */
  readonly repeat?: number
  /** SecureOn password, 12 hex digits. */
  readonly secureOn?: string
}

export interface WakeOnLanTargetFailure {
  readonly address: string
  readonly code: string
}

export type WakeOnLanResult =
  | {
      readonly ok: true
      readonly targets: readonly string[]
      readonly datagrams: number
      /** Targets whose sends all failed, when at least one other target was reached. */
      readonly failedTargets: readonly WakeOnLanTargetFailure[]
    }
  | { readonly ok: false; readonly reason: WakeOnLanRefusal; readonly detail?: string }

/** The part of a socket the sender uses; `createSocket` below adapts `node:dgram`. */
export interface WakeOnLanSocket {
  setBroadcast(flag: boolean): void
  send(message: Uint8Array, port: number, address: string): Promise<void>
  close(): void
}

export interface WakeOnLanInterface {
  readonly address: string
  readonly netmask: string
  readonly family: 'IPv4' | 'IPv6'
  readonly internal: boolean
}
export type WakeOnLanInterfaces = Readonly<
  Record<string, readonly WakeOnLanInterface[] | undefined>
>

export interface WakeOnLanDeps {
  readonly createSocket: () => WakeOnLanSocket
  readonly networkInterfaces: () => WakeOnLanInterfaces
  readonly sleep: (ms: number) => Promise<void>
}

function realSocket(): WakeOnLanSocket {
  const socket = createSocket('udp4')
  return {
    setBroadcast: (flag) => {
      socket.setBroadcast(flag)
    },
    send: (message, port, address) =>
      new Promise<void>((resolve, reject) => {
        socket.send(message, port, address, (error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
    close: () => {
      socket.close()
    },
  }
}

const REAL_DEPS: WakeOnLanDeps = {
  createSocket: realSocket,
  networkInterfaces: () => networkInterfaces(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

function prefixOfNetmask(netmask: string): number | null {
  const value = ipv4ToUint32(netmask)
  if (value === null) return null
  let bits = 0
  let seenZero = false
  for (let i = 31; i >= 0; i -= 1) {
    const set = ((value >>> i) & 1) === 1
    if (set && seenZero) return null
    if (set) bits += 1
    else seenZero = true
  }
  return bits
}

function defaultTargets(interfaces: WakeOnLanInterfaces): string[] {
  const targets: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const prefix = prefixOfNetmask(entry.netmask)
      if (prefix === null) continue
      const broadcast = directedBroadcastOf(entry.address, prefix)
      if (broadcast !== null && !targets.includes(broadcast)) targets.push(broadcast)
    }
  }
  return targets.length > 0 ? [...targets, LIMITED_BROADCAST] : []
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code
    if (typeof code === 'string') return code
  }
  return error instanceof Error ? error.message : 'unknown'
}

function parseSecureOn(secureOn: string): Uint8Array | null {
  if (!SECURE_ON_HEX.test(secureOn)) return null
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i += 1) bytes[i] = Number.parseInt(secureOn.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * Send the magic packet from THIS node. Never throws for a listed refusal.
 * `ok: true` means "datagrams left this node", NOT "the device woke": the
 * caller confirms by reaching the device.
 */
export async function sendWakeOnLan(
  request: WakeOnLanRequest,
  deps: WakeOnLanDeps = REAL_DEPS,
): Promise<WakeOnLanResult> {
  const mac = parseMacAddress(request.mac)
  if (mac === null) return { ok: false, reason: 'invalid-mac' }

  let secureOn: Uint8Array | undefined
  if (request.secureOn !== undefined) {
    const parsed = parseSecureOn(request.secureOn)
    if (parsed === null) return { ok: false, reason: 'invalid-secure-on' }
    secureOn = parsed
  }

  let targets: readonly string[]
  if (request.broadcastAddresses !== undefined) {
    const bad = request.broadcastAddresses.find((a) => ipv4ToUint32(a) === null)
    if (bad !== undefined) return { ok: false, reason: 'invalid-broadcast-address', detail: bad }
    targets = request.broadcastAddresses
  } else {
    targets = defaultTargets(deps.networkInterfaces())
  }
  if (targets.length === 0) return { ok: false, reason: 'no-broadcast-interface' }

  const port = request.port ?? WOL_PORT_DEFAULT
  const repeat = Math.min(
    WOL_REPEAT_MAX,
    Math.max(1, Math.trunc(request.repeat ?? WOL_REPEAT_DEFAULT)),
  )
  const packet = buildMagicPacket(mac, secureOn)

  const socket = deps.createSocket()
  const reached: string[] = []
  const failed: WakeOnLanTargetFailure[] = []
  let datagrams = 0
  try {
    socket.setBroadcast(true)
    const lastCode = new Map<string, string>()
    const delivered = new Set<string>()
    for (let round = 0; round < repeat; round += 1) {
      if (round > 0) await deps.sleep(WOL_REPEAT_GAP_MS)
      for (const address of targets) {
        try {
          await socket.send(packet, port, address)
          datagrams += 1
          delivered.add(address)
        } catch (error: unknown) {
          lastCode.set(address, errorCode(error))
        }
      }
    }
    for (const address of targets) {
      if (delivered.has(address)) reached.push(address)
      else failed.push({ address, code: lastCode.get(address) ?? 'unknown' })
    }
  } finally {
    socket.close()
  }

  if (reached.length === 0) {
    return {
      ok: false,
      reason: 'send-failed',
      detail: failed.map((f) => `${f.address}:${f.code}`).join(', '),
    }
  }
  return { ok: true, targets: reached, datagrams, failedTargets: failed }
}
