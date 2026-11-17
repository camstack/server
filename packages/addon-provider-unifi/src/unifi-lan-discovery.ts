import {
  DeviceType,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
} from '@camstack/types'

/**
 * LAN discovery of a UniFi OS console through the Ubiquiti discovery protocol: one UDP broadcast
 * of the v1 probe (`01 00 00 00`) to port 10001. Every Ubiquiti device answers — consoles, access
 * points, switches — with a header (version, command, 16-bit big-endian length) and TLV records
 * (1-byte type, 16-bit big-endian length, value). Only a CONSOLE is proposed as an integration;
 * access points and switches arrive as children once the console is adopted.
 */
const DISCOVERY_PORT = 10_001
const PROBE_V1_HEX = '01000000'
const HEADER_LENGTH = 4
const RECORD_HEADER_LENGTH = 3
const MAC_LENGTH = 6
const IPV4_LENGTH = 4

/** TLV types (the record types the nmap `ubiquiti-discovery` script decodes). */
const TLV_HW_ADDR = 0x01
const TLV_ADDR_IP = 0x02
const TLV_FIRMWARE = 0x03
const TLV_HOSTNAME = 0x0b
const TLV_PRODUCT = 0x0c
const TLV_MODEL_V1 = 0x14
const TLV_MODEL_V2 = 0x15

/** The announcement of the UniFi OS user-management controller: only a console runs it. */
const CONTROLLER_MARKER = 'uum_controller'

/**
 * Model / product / firmware-platform codes of a UniFi OS console: Dream Machine (UDM, UDMPRO,
 * UDM-SE), Dream Router (UDR), Cloud Gateway (UCG), Cloud Key (UCK), Dream Wall (UDW), Express
 * (UX, not UXG), the NVR (UNVR) and the Enterprise Fortress Gateway (EFG).
 */
const CONSOLE_CODE = /^(UDM|UDR|UCG|UCK|UDW|UNVR|EFG|UX(?![A-Z]))/i
const CONSOLE_NAME = /dream (machine|router|wall)|cloud (key|gateway)|unifi express/i

/** How the scan engine finds a console: one UDP broadcast, whose replies come back as hits. */
export const UNIFI_DISCOVERY_MODES: readonly DiscoveryMode[] = [
  { kind: 'udp-broadcast', port: DISCOVERY_PORT, payloadHex: PROBE_V1_HEX },
]

/** One Ubiquiti discovery reply, decoded. */
export interface UbntDiscoveryReply {
  readonly version: number
  readonly macs: readonly string[]
  readonly ips: readonly string[]
  readonly firmware?: string
  readonly hostname?: string
  readonly product?: string
  readonly model?: string
  /** The reply announces the UniFi OS controller (`uum_controller`). */
  readonly controller: boolean
}

interface MutableReply {
  macs: string[]
  ips: string[]
  firmware?: string
  hostname?: string
  product?: string
  model?: string
  controller: boolean
}

function macOf(bytes: Buffer): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':')
}

function textOf(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  const nul = text.indexOf('\u0000')
  return (nul === -1 ? text : text.slice(0, nul)).trim()
}

function applyRecord(reply: MutableReply, type: number, value: Buffer): void {
  const text = textOf(value)
  if (text.includes(CONTROLLER_MARKER)) reply.controller = true
  switch (type) {
    case TLV_HW_ADDR:
      if (value.length === MAC_LENGTH) reply.macs.push(macOf(value))
      return
    case TLV_ADDR_IP:
      if (value.length === MAC_LENGTH + IPV4_LENGTH) {
        reply.macs.push(macOf(value.subarray(0, MAC_LENGTH)))
        reply.ips.push([...value.subarray(MAC_LENGTH)].join('.'))
      }
      return
    case TLV_FIRMWARE:
      if (text.length > 0) reply.firmware = text
      return
    case TLV_HOSTNAME:
      if (text.length > 0) reply.hostname = text
      return
    case TLV_PRODUCT:
      if (text.length > 0) reply.product = text
      return
    case TLV_MODEL_V1:
    case TLV_MODEL_V2:
      if (text.length > 0) reply.model = text
      return
    default:
      return
  }
}

/**
 * Decode one reply; null when it is not a Ubiquiti discovery answer (bad header, a length that
 * does not match, or a record running past the end).
 */
export function parseUbntReply(payloadHex: string): UbntDiscoveryReply | null {
  const buf = Buffer.from(payloadHex, 'hex')
  if (buf.length < HEADER_LENGTH) return null
  const version = buf[0] ?? -1
  if (version > 2) return null
  if (buf.readUInt16BE(2) + HEADER_LENGTH !== buf.length) return null
  // A probe echoed back (our own broadcast, or another scanner's) carries no record.
  if (buf.length === HEADER_LENGTH) return null
  const reply: MutableReply = { macs: [], ips: [], controller: false }
  let at = HEADER_LENGTH
  while (at < buf.length) {
    if (at + RECORD_HEADER_LENGTH > buf.length) return null
    const type = buf[at] ?? 0
    const length = buf.readUInt16BE(at + 1)
    const end = at + RECORD_HEADER_LENGTH + length
    if (end > buf.length) return null
    applyRecord(reply, type, buf.subarray(at + RECORD_HEADER_LENGTH, end))
    at = end
  }
  return {
    version,
    ...reply,
    macs: [...new Set(reply.macs)],
    ips: [...new Set(reply.ips)],
  }
}

/** Whether a reply comes from a UniFi OS console (by its controller announcement or its model). */
export function isUnifiConsoleReply(reply: UbntDiscoveryReply): boolean {
  if (reply.controller) return true
  const platform = reply.firmware?.split('.')[0]
  const codes = [reply.model, reply.product, platform].filter(
    (code): code is string => code !== undefined && code.length > 0,
  )
  return codes.some((code) => CONSOLE_CODE.test(code) || CONSOLE_NAME.test(code))
}

/** One console found on the LAN. */
export interface UnifiDiscoveredConsole {
  readonly host: string
  /** The console's hostname, else its model, else its address. */
  readonly name: string
  readonly model?: string
}

/** A reply, or a host, the classification left out — and why (D391). */
export interface UnifiDroppedHit {
  readonly host: string
  readonly reason: 'not-ubiquiti' | 'not-a-console' | 'already-added'
  readonly detail?: string
}

export interface UnifiConsoleScan {
  readonly consoles: readonly UnifiDiscoveredConsole[]
  readonly dropped: readonly UnifiDroppedHit[]
}

interface HostReplies {
  readonly replies: UbntDiscoveryReply[]
  invalid: number
}

/**
 * Consoles among the engine's UDP replies, one per host. A console answers more than once (the
 * device reply, and a separate controller announcement), so the replies of one host are judged
 * together: one console proof is enough.
 */
export function unifiConsolesFromHits(hits: readonly DiscoveryHit[]): UnifiConsoleScan {
  const byHost = new Map<string, HostReplies>()
  for (const hit of hits) {
    if (hit.udp === undefined) continue
    const entry = byHost.get(hit.host) ?? { replies: [], invalid: 0 }
    const reply = parseUbntReply(hit.udp.payloadHex)
    if (reply === null) entry.invalid += 1
    else entry.replies.push(reply)
    byHost.set(hit.host, entry)
  }
  const consoles: UnifiDiscoveredConsole[] = []
  const dropped: UnifiDroppedHit[] = []
  for (const [host, entry] of byHost) {
    if (entry.replies.length === 0) {
      dropped.push({ host, reason: 'not-ubiquiti' })
      continue
    }
    const describing = entry.replies.find((r) => r.model !== undefined || r.hostname !== undefined)
    const model = describing?.model ?? describing?.product
    if (!entry.replies.some(isUnifiConsoleReply)) {
      const detail = model ?? entry.replies.find((r) => r.firmware !== undefined)?.firmware
      dropped.push({
        host,
        reason: 'not-a-console',
        ...(detail !== undefined ? { detail } : {}),
      })
      continue
    }
    consoles.push({
      host,
      name: describing?.hostname ?? model ?? host,
      ...(model !== undefined ? { model } : {}),
    })
  }
  return {
    consoles: consoles.toSorted((a, b) =>
      a.host.localeCompare(b.host, undefined, { numeric: true }),
    ),
    dropped,
  }
}

/** The key a scanned console gets, by the host it answered from. */
export function unifiScanKey(host: string): string {
  return `unifi-console:${host.trim().toLowerCase()}`
}

export interface UnifiConsoleProposal {
  readonly candidates: readonly DiscoveryCandidate[]
  readonly dropped: readonly UnifiDroppedHit[]
}

/**
 * A console is offered as an INTEGRATION to set up (a {@link DeviceType.Gateway} candidate marked
 * `setupIntegration`), with its host prefilled; the API key is still asked at setup. A console
 * whose host an integration already dials is left out and reported as dropped.
 */
export function unifiConsoleCandidates(
  consoles: readonly UnifiDiscoveredConsole[],
  existingHosts: readonly string[],
): UnifiConsoleProposal {
  const known = new Set(
    existingHosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0),
  )
  const candidates: DiscoveryCandidate[] = []
  const dropped: UnifiDroppedHit[] = []
  for (const found of consoles) {
    if (known.has(found.host.trim().toLowerCase())) {
      dropped.push({ host: found.host, reason: 'already-added' })
      continue
    }
    candidates.push({
      stableId: unifiScanKey(found.host),
      type: DeviceType.Gateway,
      suggestedName: `UniFi - ${found.name}`,
      prefilledConfig: { host: found.host },
      setupIntegration: true,
    })
  }
  return { candidates, dropped }
}
