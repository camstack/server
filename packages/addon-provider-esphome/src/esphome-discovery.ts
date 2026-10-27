import { createSocket, type Socket } from 'node:dgram'
import { ESPHOME_DEFAULT_PORT } from './config.js'

/** A board that announced itself on the LAN. Nothing is contacted beyond the mDNS question. */
export interface EspDiscoveredBoard {
  readonly host: string
  readonly port: number
  readonly name: string
  /** Stable identity: the board's mDNS hostname without `.local`, else the IP. */
  readonly id: string
}

export const ESPHOME_MDNS_SERVICE = '_esphomelib._tcp.local'
export const ESPHOME_DISCOVERY_TIMEOUT_MS = 2_000

/** Top bit of the question class: ask for a unicast reply (RFC 6762). */
const MDNS_QU_CLASS = 0x8001
const MDNS_PORT = 5353
const MDNS_ADDRESS = '224.0.0.251'
const PTR = 12
const A = 1
const SRV = 33
const SRV_FIXED = 6

interface DnsName {
  readonly name: string
  readonly end: number
}

function readName(buf: Buffer, start: number): DnsName | null {
  const labels: string[] = []
  let pos = start
  let end = start
  let jumped = false
  for (let hops = 0; hops < 16; hops++) {
    if (pos < 0 || pos >= buf.length) return null
    const len = buf[pos] ?? 0
    if (len === 0) {
      if (!jumped) end = pos + 1
      return { name: labels.join('.'), end }
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null
      if (!jumped) end = pos + 2
      jumped = true
      pos = ((len & 0x3f) << 8) | (buf[pos + 1] ?? 0)
      continue
    }
    if ((len & 0xc0) !== 0 || pos + 1 + len > buf.length) return null
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'))
    pos += 1 + len
    if (!jumped) end = pos
  }
  return null
}

interface DnsRecord {
  readonly name: string
  readonly type: number
  readonly message: Buffer
  readonly dataOffset: number
  readonly dataLength: number
}

function readRecords(
  buf: Buffer,
  offset: number,
  count: number,
): { readonly records: readonly DnsRecord[]; readonly next: number } | null {
  const records: DnsRecord[] = []
  let pos = offset
  for (let i = 0; i < count; i++) {
    const name = readName(buf, pos)
    if (name === null || name.end + 10 > buf.length) return null
    const type = buf.readUInt16BE(name.end)
    const dataLength = buf.readUInt16BE(name.end + 8)
    const dataOffset = name.end + 10
    if (dataOffset + dataLength > buf.length) return null
    records.push({ name: name.name, type, message: buf, dataOffset, dataLength })
    pos = dataOffset + dataLength
  }
  return { records, next: pos }
}

function ipv4(buf: Buffer, offset: number, length: number): string | null {
  if (length !== 4 || offset + 4 > buf.length) return null
  return `${buf[offset] ?? 0}.${buf[offset + 1] ?? 0}.${buf[offset + 2] ?? 0}.${buf[offset + 3] ?? 0}`
}

function stripLocal(host: string): string {
  const lower = host.trim().toLowerCase()
  return lower.endsWith('.local') ? lower.slice(0, -'.local'.length) : lower
}

function boardsFromRecords(records: readonly DnsRecord[]): readonly EspDiscoveredBoard[] {
  const instances: string[] = []
  const srv = new Map<string, { readonly target: string; readonly port: number }>()
  const addresses = new Map<string, string>()
  for (const rec of records) {
    const key = rec.name.toLowerCase()
    if (rec.type === PTR) {
      const target = readName(rec.message, rec.dataOffset)
      if (target !== null) instances.push(target.name)
    } else if (rec.type === SRV && rec.dataLength >= SRV_FIXED) {
      const target = readName(rec.message, rec.dataOffset + SRV_FIXED)
      if (target !== null) {
        srv.set(key, { target: target.name, port: rec.message.readUInt16BE(rec.dataOffset + 4) })
      }
    } else if (rec.type === A) {
      const ip = ipv4(rec.message, rec.dataOffset, rec.dataLength)
      if (ip !== null) addresses.set(key, ip)
    }
  }
  const out: EspDiscoveredBoard[] = []
  const seen = new Set<string>()
  for (const instance of instances) {
    const service = srv.get(instance.toLowerCase())
    const host =
      (service !== undefined ? addresses.get(service.target.toLowerCase()) : undefined) ??
      addresses.get(instance.toLowerCase())
    if (host === undefined || seen.has(host)) continue
    seen.add(host)
    const label = instance.split('._')[0] ?? instance
    out.push({
      host,
      port: service !== undefined && service.port > 0 ? service.port : ESPHOME_DEFAULT_PORT,
      name: label,
      id: service !== undefined ? stripLocal(service.target) : host,
    })
  }
  return out
}

/** Boards advertised on one mDNS message. */
export function boardsFromDnsMessage(buf: Buffer): readonly EspDiscoveredBoard[] {
  if (buf.length < 12) return []
  const questions = buf.readUInt16BE(4)
  const answers = buf.readUInt16BE(6)
  const authorities = buf.readUInt16BE(8)
  const extra = buf.readUInt16BE(10)
  let pos = 12
  for (let i = 0; i < questions; i++) {
    const name = readName(buf, pos)
    if (name === null) return []
    pos = name.end + 4
    if (pos > buf.length) return []
  }
  const answerRecords = readRecords(buf, pos, answers)
  if (answerRecords === null) return []
  const authorityRecords = readRecords(buf, answerRecords.next, authorities)
  if (authorityRecords === null) return []
  const extraRecords = readRecords(buf, authorityRecords.next, extra)
  if (extraRecords === null) return []
  return boardsFromRecords([
    ...answerRecords.records,
    ...authorityRecords.records,
    ...extraRecords.records,
  ])
}

export function mdnsPtrQuery(service: string): Buffer {
  const labels = service.split('.').filter((part) => part.length > 0)
  const encoded = labels.map((label) =>
    Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
  )
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(PTR, 0)
  tail.writeUInt16BE(MDNS_QU_CLASS, 2)
  return Buffer.concat([header, ...encoded, Buffer.from([0]), tail])
}

function closeQuietly(socket: Socket): void {
  try {
    socket.close()
  } catch {
    // Already closed after an error.
  }
}

function exchangeMdns(query: Buffer, timeoutMs: number): Promise<readonly Buffer[]> {
  return new Promise((resolve) => {
    let socket: Socket
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      resolve([])
      return
    }
    const packets: Buffer[] = []
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      closeQuietly(socket)
      resolve(packets)
    }
    socket.on('error', () => finish())
    socket.on('message', (msg: Buffer) => {
      packets.push(Buffer.from(msg))
    })
    socket.bind(0, () => {
      try {
        socket.send(query, MDNS_PORT, MDNS_ADDRESS)
      } catch {
        finish()
      }
    })
    setTimeout(finish, timeoutMs).unref()
  })
}

/** Ask the LAN once and collect every board that answers. Never throws. */
export async function browseBoards(
  exchange: (query: Buffer, timeoutMs: number) => Promise<readonly Buffer[]> = exchangeMdns,
): Promise<readonly EspDiscoveredBoard[]> {
  let packets: readonly Buffer[]
  try {
    packets = await exchange(mdnsPtrQuery(ESPHOME_MDNS_SERVICE), ESPHOME_DISCOVERY_TIMEOUT_MS)
  } catch {
    return []
  }
  const boards: EspDiscoveredBoard[] = []
  const seen = new Set<string>()
  for (const packet of packets) {
    for (const found of boardsFromDnsMessage(packet)) {
      if (seen.has(found.host)) continue
      seen.add(found.host)
      boards.push(found)
    }
  }
  return boards
}

/** Boards whose host or identity is already configured are not proposed again. */
export function proposeBoards(
  found: readonly EspDiscoveredBoard[],
  existingHosts: readonly string[],
): readonly EspDiscoveredBoard[] {
  const known = new Set(
    existingHosts.map((host) => stripLocal(host)).filter((host) => host.length > 0),
  )
  return found.filter((board) => !known.has(stripLocal(board.host)) && !known.has(board.id))
}
