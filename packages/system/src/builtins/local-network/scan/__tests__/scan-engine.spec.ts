import type { DiscoveryMode, IScopedLogger, LocalInterface, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildPtrQuery } from '../dns-wire.js'
import { runScan } from '../scan-engine.js'
import type {
  HttpProbeOutcome,
  HttpProbeRequest,
  ScanIo,
  UdpExchangeRequest,
  UdpReply,
} from '../scan-io.js'
import {
  MAX_SCAN_HOSTS,
  ScanSubnetError,
  parseCidr,
  resolveScanSubnets,
  validateSavedSubnets,
} from '../subnets.js'

function link(address: string, netmask = '255.255.255.0'): LocalInterface {
  return {
    name: 'eth0',
    family: 'IPv4',
    address,
    cidr: '',
    netmask,
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

function logger(): SpyLogger {
  return new SpyLogger()
}

class FakeIo implements ScanIo {
  readonly udp: UdpExchangeRequest[] = []
  readonly http: HttpProbeRequest[] = []
  udpReplies: (req: UdpExchangeRequest) => UdpReply[] = () => []
  httpAnswer: (req: HttpProbeRequest) => HttpProbeOutcome = () => ({ kind: 'unreachable' })
  async udpExchange(req: UdpExchangeRequest): Promise<readonly UdpReply[]> {
    this.udp.push(req)
    return this.udpReplies(req)
  }
  async httpProbe(req: HttpProbeRequest): Promise<HttpProbeOutcome> {
    this.http.push(req)
    return this.httpAnswer(req)
  }
}

const probeA: DiscoveryMode = {
  kind: 'http-probe',
  port: 80,
  path: '/a',
  method: 'GET',
  tls: false,
}
const probeB: DiscoveryMode = {
  kind: 'http-probe',
  port: 443,
  path: '/b',
  method: 'POST',
  bodyText: '{}',
  contentType: 'application/json',
  tls: true,
  acceptStatus: [200],
}

describe('subnet resolution', () => {
  it('unions the hub /24, the saved list and the per-call list', () => {
    const r = resolveScanSubnets({
      interfaces: [link('192.168.10.9')],
      saved: ['192.168.20.0/24'],
      perCall: ['10.0.5.7/32'],
    })
    expect(r.all.map((s) => s.cidr)).toEqual(['192.168.10.0/24', '192.168.20.0/24', '10.0.5.7/32'])
    expect(r.extra.map((s) => s.cidr)).toEqual(['192.168.20.0/24', '10.0.5.7/32'])
    expect(r.hosts).toContain('192.168.20.1')
    expect(r.hosts).toContain('10.0.5.7')
    expect(r.hosts).not.toContain('192.168.10.9')
    expect(r.hosts).not.toContain('192.168.10.0')
    expect(r.hosts).not.toContain('192.168.10.255')
  })

  it('narrows a wide own link to a /24 and ignores docker links', () => {
    const docker = { ...link('172.17.0.1', '255.255.0.0'), kind: 'docker' as const }
    const r = resolveScanSubnets({
      interfaces: [link('10.0.3.4', '255.255.0.0'), docker],
      saved: [],
      perCall: [],
    })
    expect(r.all.map((s) => s.cidr)).toEqual(['10.0.3.0/24'])
  })

  it.each([
    'nope',
    '10.0.0.0/33',
    '10.0.0.0/8',
    '10.0.0.999/24',
    '10.0.0.0/24/1',
  ])('rejects the invalid CIDR %s', (bad) => {
    expect(() => parseCidr(bad)).toThrow(ScanSubnetError)
    expect(() => validateSavedSubnets([bad])).toThrow(ScanSubnetError)
  })

  it('refuses a union above the host cap', () => {
    const many = Array.from({ length: 5 }, (_, i) => `10.${i}.0.0/22`)
    expect(MAX_SCAN_HOSTS).toBe(4096)
    expect(() => resolveScanSubnets({ interfaces: [], saved: many, perCall: [] })).toThrow(
      /more than 4096/,
    )
    expect(() =>
      resolveScanSubnets({ interfaces: [], saved: many.slice(0, 4), perCall: [] }),
    ).not.toThrow()
  })

  it('canonicalises and deduplicates a list to save', () => {
    expect(validateSavedSubnets(['192.168.20.5/24', '192.168.20.0/24'])).toEqual([
      '192.168.20.0/24',
    ])
  })
})

describe('scan engine batching', () => {
  const deps = (io: FakeIo, log = logger()) => ({
    io,
    interfaces: () => [link('192.168.10.9')],
    savedSubnets: () => [] as readonly string[],
    logger: log,
  })

  it('visits each host once and runs both providers probes there', async () => {
    const io = new FakeIo()
    io.httpAnswer = (req) =>
      req.path === '/a' && req.host === '192.168.10.20'
        ? { kind: 'response', status: 200, headers: {}, bodyText: 'a' }
        : req.path === '/b' && req.host === '192.168.10.21'
          ? { kind: 'response', status: 200, headers: {}, bodyText: 'b' }
          : { kind: 'unreachable' }
    const result = await runScan(deps(io), {
      requests: [
        { providerId: 'one', modes: [probeA] },
        { providerId: 'two', modes: [probeB] },
      ],
    })
    // 253 hosts (the hub's own address is skipped), 2 distinct probes each, never twice.
    expect(io.http).toHaveLength(253 * 2)
    const perHost = new Map<string, number>()
    for (const r of io.http) perHost.set(r.host, (perHost.get(r.host) ?? 0) + 1)
    expect([...perHost.values()].every((n) => n === 2)).toBe(true)
    expect(perHost.has('192.168.10.9')).toBe(false)
    expect(result.hits.map((h) => [h.providerId, h.hit.host, h.hit.modeIndex])).toEqual(
      expect.arrayContaining([
        ['one', '192.168.10.20', 0],
        ['two', '192.168.10.21', 0],
      ]),
    )
    expect(result.hits).toHaveLength(2)
  })

  it('sends an identical probe of two providers once and routes it to both', async () => {
    const io = new FakeIo()
    io.httpAnswer = (req) =>
      req.host === '192.168.10.30'
        ? { kind: 'response', status: 200, headers: { server: 'x' }, bodyText: 'ok' }
        : { kind: 'timeout' }
    const log = logger()
    const result = await runScan(deps(io, log), {
      requests: [
        { providerId: 'one', modes: [probeA] },
        { providerId: 'two', modes: [{ kind: 'mdns', serviceType: '_x._tcp' }, probeA] },
      ],
    })
    expect(io.http).toHaveLength(253)
    expect(result.hits.map((h) => [h.providerId, h.hit.modeIndex])).toEqual([
      ['one', 0],
      ['two', 1],
    ])
    expect(result.stats.timeouts).toBe(252)
    expect(result.stats.hostsProbed).toBe(253)
    expect(log.info).toHaveBeenCalledTimes(1)
    const summary = log.info.mock.calls[0]
    expect(summary?.[1]).toMatchObject({ meta: { hits: 2, timeouts: 252, hostsProbed: 253 } })
  })

  it('honours acceptStatus', async () => {
    const io = new FakeIo()
    io.httpAnswer = () => ({ kind: 'response', status: 404, headers: {}, bodyText: '' })
    const result = await runScan(deps(io), { requests: [{ providerId: 'two', modes: [probeB] }] })
    expect(result.hits).toHaveLength(0)
  })

  it('unions mDNS service types into one browse and fans the answers out by type', async () => {
    const io = new FakeIo()
    io.udpReplies = (req) =>
      req.targets[0]?.host === '224.0.0.251'
        ? [
            {
              host: '192.168.10.50',
              port: 5353,
              data: ptrAnswer('_esphomelib._tcp', 'board1', 6053, '192.168.10.50'),
            },
          ]
        : []
    const result = await runScan(deps(io), {
      requests: [
        { providerId: 'esphome', modes: [{ kind: 'mdns', serviceType: '_esphomelib._tcp' }] },
        {
          providerId: 'velux',
          modes: [{ kind: 'mdns', serviceType: '_http._tcp', instancePattern: '^VELUX_KLF' }],
        },
        { providerId: 'other', modes: [{ kind: 'mdns', serviceType: '_esphomelib._tcp.local' }] },
      ],
    })
    expect(io.udp).toHaveLength(1)
    const packet = io.udp[0]?.payload
    expect(packet?.equals(buildPtrQuery(['_esphomelib._tcp', '_http._tcp']))).toBe(true)
    expect(packet?.readUInt16BE(4)).toBe(2)
    expect(result.hits.map((h) => h.providerId).sort()).toEqual(['esphome', 'other'])
    expect(result.hits[0]?.hit.mdns).toMatchObject({ instance: 'board1', port: 6053 })
    expect(result.hits[0]?.hit.host).toBe('192.168.10.50')
  })

  it('asks every host of an extra subnet directly, since multicast does not cross', async () => {
    const io = new FakeIo()
    const result = await runScan(
      { ...deps(io), savedSubnets: () => ['192.168.20.0/24'] },
      { requests: [{ providerId: 'a', modes: [{ kind: 'mdns', serviceType: '_x._tcp' }] }] },
    )
    const unicast = io.udp.filter((u) => u.targets[0]?.host !== '224.0.0.251')
    expect(unicast).toHaveLength(1)
    expect(unicast[0]?.targets).toHaveLength(254)
    expect(unicast[0]?.targets.every((t) => t.port === 5353)).toBe(true)
    expect(result.subnetsScanned).toEqual(['192.168.10.0/24', '192.168.20.0/24'])
  })

  it('sends a directed broadcast on an extra subnet', async () => {
    const io = new FakeIo()
    await runScan(
      { ...deps(io), savedSubnets: () => ['192.168.20.0/24'] },
      {
        requests: [
          { providerId: 'a', modes: [{ kind: 'udp-broadcast', port: 9000, payloadHex: 'abcd' }] },
        ],
      },
    )
    expect(io.udp.map((u) => u.targets[0]?.host).sort()).toEqual([
      '192.168.10.255',
      '192.168.20.255',
    ])
    expect(io.udp.every((u) => u.broadcast === true)).toBe(true)
  })

  it('a failing mode family is reported and does not stop the others', async () => {
    const io = new FakeIo()
    io.udpExchange = async () => {
      throw new Error('socket closed')
    }
    io.httpAnswer = (req) =>
      req.host === '192.168.10.40'
        ? { kind: 'response', status: 200, headers: {}, bodyText: '' }
        : { kind: 'unreachable' }
    const result = await runScan(deps(io), {
      requests: [{ providerId: 'a', modes: [{ kind: 'ssdp', searchTarget: 'ssdp:all' }, probeA] }],
    })
    expect(result.errors).toEqual([{ mode: 'ssdp', message: 'socket closed' }])
    expect(result.hits).toHaveLength(1)
  })

  it('rejects an invalid per-call subnet', async () => {
    await expect(runScan(deps(new FakeIo()), { requests: [], subnets: ['bogus'] })).rejects.toThrow(
      ScanSubnetError,
    )
  })
})

/** A minimal mDNS answer: PTR + SRV + A for one instance. */
function ptrAnswer(type: string, instance: string, port: number, ip: string): Buffer {
  const name = (n: string): Buffer =>
    Buffer.concat([
      ...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
      Buffer.from([0]),
    ])
  const rr = (n: Buffer, rtype: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(10)
    head.writeUInt16BE(rtype, 0)
    head.writeUInt16BE(1, 2)
    head.writeUInt16BE(data.length, 8)
    return Buffer.concat([n, head, data])
  }
  const full = name(`${instance}.${type}.local`)
  const target = name(`${instance}.local`)
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(port, 4)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 6)
  header.writeUInt16BE(2, 10)
  return Buffer.concat([
    header,
    rr(name(`${type}.local`), 12, full),
    rr(full, 33, Buffer.concat([srv, target])),
    rr(target, 1, Buffer.from(ip.split('.').map(Number))),
  ])
}
