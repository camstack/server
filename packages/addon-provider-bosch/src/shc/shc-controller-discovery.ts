import { createSocket, type Socket } from 'node:dgram'

export interface ShcDiscoveredHost {
  readonly host: string
  readonly name: string
  /** Stable identity (SRV hostname without `.local`, else a serial, else the IP). */
  readonly id: string
}

/** `prefilledConfig` flag: the scan opens the integration form instead of adopting a device. */
export const SHC_SETUP_INTEGRATION_KEY = 'setupIntegration'

/** Top bit of the question class: ask for a unicast reply (RFC 6762). */
const MDNS_QU_CLASS = 0x8001

export const SHC_MDNS_SERVICE = '_http._tcp.local'
export const SHC_CONTROLLER_NAME_PREFIX = 'Bosch SHC'
export const SHC_DISCOVERY_TIMEOUT_MS = 1_500
const MDNS_PORT = 5353
const MDNS_ADDRESS = '224.0.0.251'
const PTR = 12
const A = 1
const SRV = 33

export function isShcControllerName(name: string): boolean {
  const instance = name.split('._')[0] ?? name
  return instance.toLowerCase().startsWith(SHC_CONTROLLER_NAME_PREFIX.toLowerCase())
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

/** Identity used to recognise a controller already stored on an integration. */
export function shcControllerId(input: {
  readonly name: string
  readonly host: string
  readonly serviceHost?: string
}): string {
  const service = input.serviceHost?.trim().toLowerCase() ?? ''
  if (service.length > 0) {
    return service.endsWith('.local') ? service.slice(0, -'.local'.length) : service
  }
  const serial = /\[([^\]]+)\]/.exec(input.name)?.[1]?.trim().toLowerCase() ?? ''
  if (serial.length > 0) return serial
  return input.host
}

function hostsFromRecords(records: readonly DnsRecord[]): readonly ShcDiscoveredHost[] {
  const instances: string[] = []
  const srv = new Map<string, string>()
  const addresses = new Map<string, string>()
  for (const rec of records) {
    const key = rec.name.toLowerCase()
    if (rec.type === PTR) {
      const target = readName(rec.message, rec.dataOffset)
      if (target !== null && isShcControllerName(target.name)) instances.push(target.name)
    } else if (rec.type === SRV && rec.dataLength >= 6) {
      const target = readName(rec.message, rec.dataOffset + 6)
      if (target !== null) srv.set(key, target.name)
    } else if (rec.type === A) {
      const ip = ipv4(rec.message, rec.dataOffset, rec.dataLength)
      if (ip !== null) addresses.set(key, ip)
    }
  }
  const out: ShcDiscoveredHost[] = []
  const seen = new Set<string>()
  for (const instance of instances) {
    const viaSrv = srv.get(instance.toLowerCase())
    const host =
      (viaSrv !== undefined ? addresses.get(viaSrv.toLowerCase()) : undefined) ??
      addresses.get(instance.toLowerCase())
    if (host === undefined || seen.has(host)) continue
    seen.add(host)
    const label = instance.split('._')[0] ?? instance
    const id = shcControllerId({
      name: label,
      host,
      ...(viaSrv !== undefined ? { serviceHost: viaSrv } : {}),
    })
    out.push({ host, name: label, id })
  }
  return out
}

function identityKeys(found: ShcDiscoveredHost): readonly string[] {
  const host = found.host.trim().toLowerCase()
  const id = found.id.trim().toLowerCase()
  const keys = [host, id]
  if (id.length > 0 && !id.endsWith('.local')) keys.push(`${id}.local`)
  return keys
}

/** Controllers whose host or id is already stored on an integration are not proposed again. */
export function proposeShcControllers(
  found: readonly ShcDiscoveredHost[],
  existingHosts: readonly string[],
): readonly ShcDiscoveredHost[] {
  const known = new Set(
    existingHosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0),
  )
  return found.filter((item) => !identityKeys(item).some((key) => known.has(key)))
}

export interface ShcDiscoveryCandidateShape {
  readonly stableId: string
  readonly suggestedName: string
  readonly prefilledConfig: Readonly<Record<string, unknown>>
}

export function shcDiscoveryCandidates(
  proposals: readonly ShcDiscoveredHost[],
): readonly ShcDiscoveryCandidateShape[] {
  return proposals.map((found) => ({
    stableId: `bosch-shc:${found.id}`,
    suggestedName: found.name,
    prefilledConfig: {
      host: found.host,
      [SHC_SETUP_INTEGRATION_KEY]: true,
    },
  }))
}

export function shcDiscoverySummary(foundCount: number, proposedCount: number): string {
  if (proposedCount === 0 && foundCount > 0) return 'Controller already added.'
  if (proposedCount === 0) return 'No controller found on the network.'
  const noun = proposedCount === 1 ? 'controller' : 'controllers'
  return `Found ${proposedCount} ${noun}.`
}

/** Hosts advertised as a Bosch Smart Home Controller on one mDNS message. */
export function shcHostsFromDnsMessage(buf: Buffer): readonly ShcDiscoveredHost[] {
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
  return hostsFromRecords([
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
    setTimeout(finish, timeoutMs)
  })
}

export async function browseShcControllers(
  exchange: (query: Buffer, timeoutMs: number) => Promise<readonly Buffer[]> = exchangeMdns,
): Promise<readonly ShcDiscoveredHost[]> {
  let packets: readonly Buffer[]
  try {
    packets = await exchange(mdnsPtrQuery(SHC_MDNS_SERVICE), SHC_DISCOVERY_TIMEOUT_MS)
  } catch {
    return []
  }
  const hosts: ShcDiscoveredHost[] = []
  const seen = new Set<string>()
  for (const packet of packets) {
    for (const found of shcHostsFromDnsMessage(packet)) {
      if (seen.has(found.host)) continue
      seen.add(found.host)
      hosts.push(found)
    }
  }
  return hosts
}

/** Manual host wins. Otherwise the address discovery filled in. */
export function resolveShcPairingHost(input: {
  readonly host?: string
  readonly hostManual?: string
}): string {
  const manual = input.hostManual?.trim() ?? ''
  if (manual.length > 0) return manual
  const host = input.host?.trim() ?? ''
  if (host.length > 0) return host
  throw new Error('Enter the controller host or IP address.')
}
