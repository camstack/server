/**
 * DNS-SD wire format for the scan engine: one PTR question per service type,
 * and a parser that turns an answer into services (instance, host, port, TXT).
 */

/** Top bit of the question class: ask for a unicast reply (RFC 6762). */
const MDNS_QU_CLASS = 0x8001
const A = 1
const PTR = 12
const TXT = 16
const SRV = 33
const SRV_FIXED = 6
const MAX_NAME_HOPS = 16

export const MDNS_PORT = 5353
export const MDNS_GROUP = '224.0.0.251'

/** `_esphomelib._tcp` and `_esphomelib._tcp.local.` name the same service. */
export function normalizeServiceType(serviceType: string): string {
  const lower = serviceType.trim().toLowerCase().replace(/\.$/, '')
  return lower.endsWith('.local') ? lower.slice(0, -'.local'.length) : lower
}

export interface MdnsService {
  readonly serviceType: string
  readonly instance: string
  /** The A record address when the answer carried one. */
  readonly address: string | null
  readonly host: string
  readonly port: number
  readonly txt: Readonly<Record<string, string>>
}

interface DnsName {
  readonly name: string
  readonly end: number
}

function readName(buf: Buffer, start: number): DnsName | null {
  const labels: string[] = []
  let pos = start
  let end = start
  let jumped = false
  for (let hops = 0; hops < MAX_NAME_HOPS; hops++) {
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
    records.push({ name: name.name, type, dataOffset, dataLength })
    pos = dataOffset + dataLength
  }
  return { records, next: pos }
}

function parseTxt(buf: Buffer, offset: number, length: number): Record<string, string> {
  const out: Record<string, string> = {}
  let pos = offset
  const end = offset + length
  while (pos < end) {
    const len = buf[pos] ?? 0
    pos += 1
    if (len === 0 || pos + len > end) break
    const entry = buf.subarray(pos, pos + len).toString('utf8')
    pos += len
    const eq = entry.indexOf('=')
    if (eq < 0) out[entry] = ''
    else out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

/** One PTR question per service type, all with the unicast-reply bit. */
export function buildPtrQuery(serviceTypes: readonly string[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(serviceTypes.length, 4)
  const questions = serviceTypes.map((type) => {
    const name = `${normalizeServiceType(type)}.local`
    const labels = name.split('.').filter((part) => part.length > 0)
    const encoded = labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
    const tail = Buffer.alloc(4)
    tail.writeUInt16BE(PTR, 0)
    tail.writeUInt16BE(MDNS_QU_CLASS, 2)
    return Buffer.concat([...encoded, Buffer.from([0]), tail])
  })
  return Buffer.concat([header, ...questions])
}

/** The services advertised on one mDNS message; a malformed packet yields none. */
export function parseMdnsMessage(buf: Buffer): readonly MdnsService[] {
  if (buf.length < 12) return []
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o))
  const [questions = 0, answers = 0, authorities = 0, extra = 0] = counts
  let pos = 12
  for (let i = 0; i < questions; i++) {
    const name = readName(buf, pos)
    if (name === null) return []
    pos = name.end + 4
    if (pos > buf.length) return []
  }
  const records: DnsRecord[] = []
  for (const count of [answers, authorities, extra]) {
    const read = readRecords(buf, pos, count)
    if (read === null) return []
    records.push(...read.records)
    pos = read.next
  }
  const ptrs: { readonly serviceType: string; readonly instance: string }[] = []
  const srv = new Map<string, { readonly target: string; readonly port: number }>()
  const txt = new Map<string, Record<string, string>>()
  const addresses = new Map<string, string>()
  for (const rec of records) {
    const key = rec.name.toLowerCase()
    if (rec.type === PTR) {
      const target = readName(buf, rec.dataOffset)
      if (target !== null) ptrs.push({ serviceType: rec.name, instance: target.name })
    } else if (rec.type === SRV && rec.dataLength >= SRV_FIXED) {
      const target = readName(buf, rec.dataOffset + SRV_FIXED)
      if (target !== null) {
        srv.set(key, { target: target.name, port: buf.readUInt16BE(rec.dataOffset + 4) })
      }
    } else if (rec.type === TXT) {
      txt.set(key, parseTxt(buf, rec.dataOffset, rec.dataLength))
    } else if (rec.type === A && rec.dataLength === 4) {
      addresses.set(
        key,
        `${buf[rec.dataOffset]}.${buf[rec.dataOffset + 1]}.${buf[rec.dataOffset + 2]}.${buf[rec.dataOffset + 3]}`,
      )
    }
  }
  const out: MdnsService[] = []
  for (const { serviceType, instance } of ptrs) {
    const service = srv.get(instance.toLowerCase())
    const target = service?.target ?? instance
    out.push({
      serviceType: normalizeServiceType(serviceType),
      instance,
      address: addresses.get(target.toLowerCase()) ?? addresses.get(instance.toLowerCase()) ?? null,
      host: target,
      port: service?.port ?? 0,
      txt: txt.get(instance.toLowerCase()) ?? {},
    })
  }
  return out
}
