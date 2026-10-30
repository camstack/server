/**
 * The LAN discovery engine.
 *
 * Providers DECLARE how they are found (`DiscoveryMode`); this runs every
 * declared mode ONCE for all of them: one mDNS browse for the union of service
 * types, one WS-Discovery probe, one SSDP search per target, one host sweep
 * that visits each host once and runs every http-probe of every provider, and
 * the directed UDP broadcasts. Hits are fanned out per provider and mode.
 *
 * Multicast does not cross subnets, so on a subnet that is not one of the
 * hub's own links the engine asks each host directly instead: a unicast
 * DNS-SD / WS-Discovery / SSDP query, a directed broadcast.
 *
 * Bounded: 64 requests in flight, 1.2 s per request, 4096 hosts per scan.
 * The sockets are injected ({@link ScanIo}), so this is unit-testable.
 */
import type {
  DiscoveryHit,
  DiscoveryMode,
  IScopedLogger,
  LocalInterface,
  ScanNetworkResult,
  ScanRequest,
  ScanStats,
} from '@camstack/types'
import {
  buildPtrQuery,
  MDNS_GROUP,
  MDNS_PORT,
  normalizeServiceType,
  parseMdnsMessage,
} from './dns-wire.js'
import { MAX_HIT_BODY_BYTES, type HttpProbeRequest, type ScanIo, type UdpReply } from './scan-io.js'
import {
  broadcastOf,
  containsAddress,
  isScannableLink,
  type ResolvedSubnets,
  resolveScanSubnets,
} from './subnets.js'

export const SCAN_CONCURRENCY = 64
export const SCAN_REQUEST_TIMEOUT_MS = 1_200
const MULTICAST_LISTEN_MS = 2_000
const UNICAST_LISTEN_MS = 1_200
const WSD_GROUP = '239.255.255.250'
const WSD_PORT = 3702
const SSDP_PORT = 1900
const MAX_HEADERS_PER_HIT = 32

export interface ScanEngineDeps {
  readonly io: ScanIo
  readonly interfaces: () => readonly LocalInterface[]
  readonly savedSubnets: () => readonly string[]
  readonly logger: IScopedLogger
}

export interface ScanInput {
  readonly requests: readonly ScanRequest[]
  readonly subnets?: readonly string[]
}

type ModeKind = DiscoveryMode['kind']

/** One declared mode of one provider: where a hit goes back to. */
interface Entry<M extends DiscoveryMode = DiscoveryMode> {
  readonly providerId: string
  readonly modeIndex: number
  readonly mode: M
}

interface Collector {
  readonly hits: { providerId: string; hit: DiscoveryHit }[]
  readonly errors: { providerId?: string; mode?: string; message: string }[]
  readonly stats: Map<string, { probed: number; hits: number; timeouts: number }>
}

function bucket(c: Collector, kind: ModeKind): { probed: number; hits: number; timeouts: number } {
  const existing = c.stats.get(kind)
  if (existing !== undefined) return existing
  const fresh = { probed: 0, hits: 0, timeouts: 0 }
  c.stats.set(kind, fresh)
  return fresh
}

function emit(c: Collector, entry: Entry, hit: Omit<DiscoveryHit, 'modeIndex'>): void {
  c.hits.push({ providerId: entry.providerId, hit: { ...hit, modeIndex: entry.modeIndex } })
  bucket(c, entry.mode.kind).hits += 1
}

function isKind<K extends ModeKind>(
  mode: DiscoveryMode,
  kind: K,
): mode is Extract<DiscoveryMode, { kind: K }> {
  return mode.kind === kind
}

function entriesOf<K extends ModeKind>(
  requests: readonly ScanRequest[],
  kind: K,
): readonly Entry<Extract<DiscoveryMode, { kind: K }>>[] {
  const out: Entry<Extract<DiscoveryMode, { kind: K }>>[] = []
  for (const req of requests) {
    req.modes.forEach((mode, modeIndex) => {
      if (isKind(mode, kind)) out.push({ providerId: req.providerId, modeIndex, mode })
    })
  }
  return out
}

/** Hosts of the subnets multicast cannot reach. */
function extraHostsOf(subnets: ResolvedSubnets): readonly string[] {
  return subnets.hosts.filter((h) => subnets.extra.some((s) => containsAddress(s, h)))
}

/** Run `task` over `items` with at most `limit` in flight. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const item = items[index]
      if (index >= items.length || item === undefined) return
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function hubLinks(interfaces: readonly LocalInterface[]): readonly LocalInterface[] {
  return interfaces.filter(isScannableLink)
}

function instanceLabel(instance: string): string {
  return instance.split('._')[0] ?? instance
}

// ── mDNS ────────────────────────────────────────────────────────────────────

async function runMdns(
  deps: ScanEngineDeps,
  entries: readonly Entry<Extract<DiscoveryMode, { kind: 'mdns' }>>[],
  subnets: ResolvedSubnets,
  c: Collector,
): Promise<void> {
  if (entries.length === 0) return
  const types = [...new Set(entries.map((e) => normalizeServiceType(e.mode.serviceType)))]
  const query = buildPtrQuery(types)
  const replies: UdpReply[] = []
  const links = hubLinks(deps.interfaces())
  for (const link of links) {
    bucket(c, 'mdns').probed += 1
    replies.push(
      ...(await deps.io.udpExchange({
        payload: query,
        targets: [{ host: MDNS_GROUP, port: MDNS_PORT }],
        localAddress: link.address,
        listenMs: MULTICAST_LISTEN_MS,
      })),
    )
  }
  const extraHosts = extraHostsOf(subnets)
  if (extraHosts.length > 0) {
    bucket(c, 'mdns').probed += extraHosts.length
    replies.push(
      ...(await deps.io.udpExchange({
        payload: query,
        targets: extraHosts.map((host) => ({ host, port: MDNS_PORT })),
        listenMs: UNICAST_LISTEN_MS,
      })),
    )
  }
  for (const reply of replies) {
    for (const service of parseMdnsMessage(reply.data)) {
      for (const entry of entries) {
        if (normalizeServiceType(entry.mode.serviceType) !== service.serviceType) continue
        const label = instanceLabel(service.instance)
        if (
          entry.mode.instancePattern !== undefined &&
          !matches(entry.mode.instancePattern, label)
        ) {
          continue
        }
        const host = service.address ?? reply.host
        emit(c, entry, {
          host,
          port: service.port,
          mdns: { instance: label, host: service.host, port: service.port, txt: service.txt },
        })
      }
    }
  }
}

function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

// ── WS-Discovery and SSDP ───────────────────────────────────────────────────

function wsdProbe(): Buffer {
  const id = `uuid:${Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10))
    .join('')
    .slice(0, 32)}`
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><e:Header><w:MessageID>${id}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe/></e:Body></e:Envelope>`,
  )
}

function xmlText(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([^<]*)</(?:[\\w-]+:)?${tag}>`, 'g')
  for (const m of xml.matchAll(re)) {
    const text = m[1]?.trim()
    if (text !== undefined && text.length > 0) out.push(...text.split(/\s+/))
  }
  return out
}

async function exchangeEverywhere(
  deps: ScanEngineDeps,
  kind: ModeKind,
  payload: Buffer,
  multicast: { readonly host: string; readonly port: number },
  unicastPort: number,
  subnets: ResolvedSubnets,
  c: Collector,
): Promise<readonly UdpReply[]> {
  const replies: UdpReply[] = []
  for (const link of hubLinks(deps.interfaces())) {
    bucket(c, kind).probed += 1
    replies.push(
      ...(await deps.io.udpExchange({
        payload,
        targets: [multicast],
        localAddress: link.address,
        listenMs: MULTICAST_LISTEN_MS,
      })),
    )
  }
  const extraHosts = extraHostsOf(subnets)
  if (extraHosts.length > 0) {
    bucket(c, kind).probed += extraHosts.length
    replies.push(
      ...(await deps.io.udpExchange({
        payload,
        targets: extraHosts.map((host) => ({ host, port: unicastPort })),
        listenMs: UNICAST_LISTEN_MS,
      })),
    )
  }
  return replies
}

async function runWsDiscovery(
  deps: ScanEngineDeps,
  entries: readonly Entry<Extract<DiscoveryMode, { kind: 'ws-discovery' }>>[],
  subnets: ResolvedSubnets,
  c: Collector,
): Promise<void> {
  if (entries.length === 0) return
  const replies = await exchangeEverywhere(
    deps,
    'ws-discovery',
    wsdProbe(),
    { host: WSD_GROUP, port: WSD_PORT },
    WSD_PORT,
    subnets,
    c,
  )
  for (const reply of replies) {
    const xml = reply.data.toString('utf8')
    const xaddrs = xmlText(xml, 'XAddrs')
    const types = xmlText(xml, 'Types')
    const scopes = xmlText(xml, 'Scopes')
    if (xaddrs.length === 0 && types.length === 0) continue
    const first = xaddrs[0] === undefined ? null : safeUrl(xaddrs[0])
    for (const entry of entries) {
      const wanted = entry.mode.types
      if (wanted !== undefined && !wanted.some((w) => types.some((t) => t.includes(w)))) continue
      emit(c, entry, {
        host: first?.hostname ?? reply.host,
        port:
          first === null
            ? reply.port
            : Number(first.port || (first.protocol === 'https:' ? 443 : 80)),
        wsd: { xaddrs, types, scopes },
      })
    }
  }
}

function safeUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

function parseSsdp(data: Buffer): { status: number; headers: Record<string, string> } | null {
  const lines = data.toString('utf8').split(/\r?\n/)
  const first = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] ?? '')
  if (first === null) return null
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (Object.keys(headers).length >= MAX_HEADERS_PER_HIT) break
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { status: Number(first[1]), headers }
}

async function runSsdp(
  deps: ScanEngineDeps,
  entries: readonly Entry<Extract<DiscoveryMode, { kind: 'ssdp' }>>[],
  subnets: ResolvedSubnets,
  c: Collector,
): Promise<void> {
  for (const target of new Set(entries.map((e) => e.mode.searchTarget))) {
    const payload = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${WSD_GROUP}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${target}\r\n\r\n`,
    )
    const replies = await exchangeEverywhere(
      deps,
      'ssdp',
      payload,
      { host: WSD_GROUP, port: SSDP_PORT },
      SSDP_PORT,
      subnets,
      c,
    )
    for (const reply of replies) {
      const parsed = parseSsdp(reply.data)
      if (parsed === null) continue
      for (const entry of entries) {
        if (entry.mode.searchTarget !== target) continue
        emit(c, entry, {
          host: reply.host,
          port: reply.port,
          http: { status: parsed.status, headers: parsed.headers, bodyText: '' },
        })
      }
    }
  }
}

// ── UDP broadcast ───────────────────────────────────────────────────────────

async function runUdpBroadcast(
  deps: ScanEngineDeps,
  entries: readonly Entry<Extract<DiscoveryMode, { kind: 'udp-broadcast' }>>[],
  subnets: ResolvedSubnets,
  c: Collector,
): Promise<void> {
  const groups = new Map<string, Entry<Extract<DiscoveryMode, { kind: 'udp-broadcast' }>>[]>()
  for (const entry of entries) {
    const { port, payloadHex, listenPort } = entry.mode
    const key = `${port}|${payloadHex.toLowerCase()}|${listenPort ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const links = hubLinks(deps.interfaces())
  for (const group of groups.values()) {
    const first = group[0]
    if (first === undefined) continue
    const { port, payloadHex, listenPort } = first.mode
    const payload = Buffer.from(payloadHex, 'hex')
    const replies: UdpReply[] = []
    const ownBroadcasts = subnets.all
      .filter((s) => !subnets.extra.some((x) => x.cidr === s.cidr))
      .map((s) => ({
        link: links.find((l) => containsAddress(s, l.address)),
        host: broadcastOf(s),
      }))
    const sends = [
      ...ownBroadcasts.map((b) => ({ localAddress: b.link?.address, host: b.host })),
      ...subnets.extra.map((s) => ({ localAddress: undefined, host: broadcastOf(s) })),
    ]
    for (const send of sends) {
      bucket(c, 'udp-broadcast').probed += 1
      replies.push(
        ...(await deps.io.udpExchange({
          payload,
          targets: [{ host: send.host, port }],
          ...(send.localAddress !== undefined ? { localAddress: send.localAddress } : {}),
          ...(listenPort !== undefined ? { bindPort: listenPort } : {}),
          broadcast: true,
          listenMs: UNICAST_LISTEN_MS,
        })),
      )
    }
    for (const reply of replies) {
      for (const entry of group) {
        emit(c, entry, {
          host: reply.host,
          port: reply.port,
          udp: { payloadHex: reply.data.toString('hex') },
        })
      }
    }
  }
}

// ── HTTP host sweep ─────────────────────────────────────────────────────────

type HttpEntry = Entry<Extract<DiscoveryMode, { kind: 'http-probe' }>>

function probeKey(m: HttpEntry['mode']): string {
  return [m.port, m.method, m.path, m.tls, m.contentType ?? '', m.bodyText ?? ''].join('|')
}

async function runHttpSweep(
  deps: ScanEngineDeps,
  entries: readonly HttpEntry[],
  subnets: ResolvedSubnets,
  c: Collector,
): Promise<void> {
  if (entries.length === 0) return
  // Identical probes of several providers are ONE request, routed to all of them.
  const probes = new Map<string, HttpEntry[]>()
  for (const entry of entries) {
    const key = probeKey(entry.mode)
    probes.set(key, [...(probes.get(key) ?? []), entry])
  }
  const stats = bucket(c, 'http-probe')
  // One task per HOST: the sweep visits each host once and runs every probe there.
  await pool(subnets.hosts, SCAN_CONCURRENCY, async (host) => {
    for (const group of probes.values()) {
      const mode = group[0]?.mode
      if (mode === undefined) continue
      const request: HttpProbeRequest = {
        host,
        port: mode.port,
        path: mode.path,
        method: mode.method,
        tls: mode.tls,
        timeoutMs: SCAN_REQUEST_TIMEOUT_MS,
        ...(mode.bodyText !== undefined ? { bodyText: mode.bodyText } : {}),
        ...(mode.contentType !== undefined ? { contentType: mode.contentType } : {}),
      }
      stats.probed += 1
      const outcome = await deps.io.httpProbe(request)
      if (outcome.kind === 'timeout') stats.timeouts += 1
      if (outcome.kind !== 'response') continue
      for (const entry of group) {
        const accept = entry.mode.acceptStatus
        if (accept !== undefined && !accept.includes(outcome.status)) continue
        emit(c, entry, {
          host,
          port: mode.port,
          http: {
            status: outcome.status,
            headers: outcome.headers,
            bodyText: outcome.bodyText.slice(0, MAX_HIT_BODY_BYTES),
          },
        })
      }
    }
  })
}

// ── The scan ────────────────────────────────────────────────────────────────

/** Why a family of modes failed, without taking the others down with it. */
async function guarded(c: Collector, kind: ModeKind, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (err) {
    c.errors.push({ mode: kind, message: err instanceof Error ? err.message : String(err) })
  }
}

export async function runScan(deps: ScanEngineDeps, input: ScanInput): Promise<ScanNetworkResult> {
  const startedAt = Date.now()
  const interfaces = deps.interfaces()
  const subnets = resolveScanSubnets({
    interfaces,
    saved: deps.savedSubnets(),
    perCall: input.subnets ?? [],
  })
  const c: Collector = { hits: [], errors: [], stats: new Map() }
  await Promise.all([
    guarded(c, 'mdns', () => runMdns(deps, entriesOf(input.requests, 'mdns'), subnets, c)),
    guarded(c, 'ws-discovery', () =>
      runWsDiscovery(deps, entriesOf(input.requests, 'ws-discovery'), subnets, c),
    ),
    guarded(c, 'ssdp', () => runSsdp(deps, entriesOf(input.requests, 'ssdp'), subnets, c)),
    guarded(c, 'udp-broadcast', () =>
      runUdpBroadcast(deps, entriesOf(input.requests, 'udp-broadcast'), subnets, c),
    ),
    guarded(c, 'http-probe', () =>
      runHttpSweep(deps, entriesOf(input.requests, 'http-probe'), subnets, c),
    ),
  ])
  const byMode = Object.fromEntries(c.stats)
  const stats: ScanStats = {
    hostsProbed: byMode['http-probe'] === undefined ? 0 : subnets.hosts.length,
    hits: c.hits.length,
    timeouts: [...c.stats.values()].reduce((n, s) => n + s.timeouts, 0),
    byMode,
  }
  deps.logger.info('local-network: scan finished', {
    meta: {
      providers: input.requests.length,
      subnets: subnets.all.map((s) => s.cidr),
      hostsProbed: stats.hostsProbed,
      hits: stats.hits,
      timeouts: stats.timeouts,
      errors: c.errors.length,
      byMode,
      ms: Date.now() - startedAt,
    },
  })
  return {
    hits: c.hits,
    subnetsScanned: subnets.all.map((s) => s.cidr),
    errors: c.errors,
    stats,
  }
}
