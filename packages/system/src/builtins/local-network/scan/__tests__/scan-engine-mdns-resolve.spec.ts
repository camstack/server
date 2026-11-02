import type { IScopedLogger, LocalInterface, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { runScan } from '../scan-engine.js'
import type { HttpProbeOutcome, ScanIo, UdpExchangeRequest, UdpReply } from '../scan-io.js'

const PTR = 12
const SRV = 33
const A = 1
const TXT = 16
const TYPE = '_http._tcp'
const INSTANCE = 'VELUX_KLF_LAN_C527'
const TARGET = 'VELUX_KLF_LAN_C527.local'
const REFLECTOR = '192.168.1.1'
const DEVICE = '192.168.20.65'

function name(n: string): Buffer {
  return Buffer.concat([
    ...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0]),
  ])
}

function rr(owner: string, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([name(owner), head, data])
}

const full = `${INSTANCE}.${TYPE}.local`
const ptrRecord = (): Buffer => rr(`${TYPE}.local`, PTR, name(full))
const srvRecord = (port: number): Buffer => {
  const fixed = Buffer.alloc(6)
  fixed.writeUInt16BE(port, 4)
  return rr(full, SRV, Buffer.concat([fixed, name(TARGET)]))
}
const txtRecord = (): Buffer =>
  rr(full, TXT, Buffer.concat([Buffer.from([8]), Buffer.from('fw=1.2.3')]))
const aRecord = (ip: string): Buffer => rr(TARGET, A, Buffer.from(ip.split('.').map(Number)))

function packet(records: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
}

function link(address: string): LocalInterface {
  return {
    name: 'eth0',
    family: 'IPv4',
    address,
    cidr: '',
    netmask: '255.255.255.0',
    internal: false,
    mac: '00:00:00:00:00:00',
    kind: 'lan',
    preferred: true,
    plausible: true,
    plausibleReason: '',
  }
}

class SpyLogger implements IScopedLogger {
  readonly info = vi.fn<(message: string, extras?: LogExtras) => void>()
  debug(): void {}
  warn(): void {}
  error(): void {}
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

/** Replies by the order of group queries: the PTR browse first, then each follow-up. */
class FakeIo implements ScanIo {
  readonly udp: UdpExchangeRequest[] = []
  constructor(private readonly answers: readonly (readonly UdpReply[])[]) {}
  async udpExchange(req: UdpExchangeRequest): Promise<readonly UdpReply[]> {
    this.udp.push(req)
    return this.answers[this.udp.length - 1] ?? []
  }
  async httpProbe(): Promise<HttpProbeOutcome> {
    return { kind: 'unreachable' }
  }
}

const reply = (host: string, records: readonly Buffer[]): UdpReply => ({
  host,
  port: 5353,
  data: packet(records),
})

const request = {
  requests: [
    {
      providerId: 'velux',
      modes: [{ kind: 'mdns' as const, serviceType: TYPE, instancePattern: '^VELUX_KLF' }],
    },
  ],
}

function run(io: FakeIo, log: SpyLogger) {
  return runScan(
    { io, interfaces: () => [link('192.168.10.9')], savedSubnets: () => [], logger: log },
    request,
  )
}

describe('mDNS hit resolution (reflector sends the PTR alone)', () => {
  it('takes the host from the SRV target A record and the port from the SRV, not the packet source', async () => {
    const io = new FakeIo([
      [reply(REFLECTOR, [ptrRecord()])],
      [reply(REFLECTOR, [srvRecord(80), txtRecord(), aRecord(DEVICE)])],
    ])
    const result = await run(io, new SpyLogger())
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.hit.host).toBe(DEVICE)
    expect(result.hits[0]?.hit.port).toBe(80)
    expect(result.hits[0]?.hit.mdns).toMatchObject({ instance: INSTANCE, host: TARGET, port: 80 })
    expect(io.udp).toHaveLength(2)
    expect(io.udp[1]?.targets).toEqual([{ host: '224.0.0.251', port: 5353 }])
    expect(io.udp[1]?.joinGroup).toBe('224.0.0.251')
  })

  it('asks for the A record in a second question when the SRV answer carries no address', async () => {
    const io = new FakeIo([
      [reply(REFLECTOR, [ptrRecord()])],
      [reply(REFLECTOR, [srvRecord(80)])],
      [reply(REFLECTOR, [aRecord(DEVICE)])],
    ])
    const result = await run(io, new SpyLogger())
    expect(result.hits.map((h) => [h.hit.host, h.hit.port])).toEqual([[DEVICE, 80]])
    expect(io.udp).toHaveLength(3)
  })

  it('leaves an instance that never resolves out of the hits and logs it once', async () => {
    const io = new FakeIo([[reply(REFLECTOR, [ptrRecord()])]])
    const log = new SpyLogger()
    const result = await run(io, log)
    expect(result.hits).toHaveLength(0)
    const lines = log.info.mock.calls.filter((c) => c[1]?.meta?.['instance'] === INSTANCE)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[1]?.meta?.['reason']).toBe('srv-unresolved')
    const finished = log.info.mock.calls.find((c) => c[0] === 'local-network: scan finished')
    expect(finished?.[1]?.meta?.['mdnsUnresolved']).toBe(1)
  })

  it('names a-unresolved when the SRV is known but the target never answers', async () => {
    const io = new FakeIo([[reply(REFLECTOR, [ptrRecord(), srvRecord(80)])]])
    const log = new SpyLogger()
    const result = await run(io, log)
    expect(result.hits).toHaveLength(0)
    const line = log.info.mock.calls.find((c) => c[1]?.meta?.['instance'] === INSTANCE)
    expect(line?.[1]?.meta?.['reason']).toBe('a-unresolved')
  })

  it('needs no follow-up when one packet carries PTR, SRV and A', async () => {
    const io = new FakeIo([
      [reply(DEVICE, [ptrRecord(), srvRecord(80), txtRecord(), aRecord(DEVICE)])],
    ])
    const result = await run(io, new SpyLogger())
    expect(result.hits.map((h) => [h.hit.host, h.hit.port])).toEqual([[DEVICE, 80]])
    expect(io.udp).toHaveLength(1)
  })
})
