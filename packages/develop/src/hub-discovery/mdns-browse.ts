/**
 * Browse the LAN for hubs over mDNS (D838): the hub publishes ONE
 * `_camstack._tcp` service for its HTTPS endpoint. This module only listens
 * for that service — it never reads the mesh multicast channel (D826 retired
 * it on the hub, so it can only ever show pre-D826 hubs).
 */
import { HUB_MDNS_QUERY_NAME, HUB_MDNS_ROLE, HUB_MDNS_TXT_KEYS } from '@camstack/types'
import makeMdns from 'multicast-dns'

/** The records the browse cares about, free of the wire library's types. */
export type MdnsRecord =
  | { readonly kind: 'ptr'; readonly name: string; readonly target: string }
  | {
      readonly kind: 'srv'
      readonly name: string
      readonly port: number
      readonly target: string
    }
  | { readonly kind: 'txt'; readonly name: string; readonly entries: readonly string[] }
  | { readonly kind: 'a'; readonly name: string; readonly address: string }

/** One response packet: its records and the sender's address. */
export interface MdnsResponse {
  readonly records: readonly MdnsRecord[]
  readonly from: string
}

/** The mDNS socket seam; a fake implements it in specs. */
export interface MdnsSocket {
  onResponse(listener: (response: MdnsResponse) => void): void
  onError(listener: (error: Error) => void): void
  query(name: string): void
  destroy(): void
}

export interface MdnsHub {
  /** Base https URL, no trailing slash. */
  readonly url: string
  readonly nodeId: string | null
  readonly version: string | null
}

export interface BrowseOptions {
  readonly timeoutMs: number
  readonly createSocket?: () => MdnsSocket
  /** Re-ask this often so a hub that missed the first question answers. */
  readonly requeryMs?: number
  /** Told why the browse found nothing when the multicast stack failed. */
  readonly onProblem?: (message: string) => void
}

export function createRealMdnsSocket(): MdnsSocket {
  const socket = makeMdns()
  return {
    onResponse: (listener) => {
      socket.on('response', (packet, rinfo) => {
        const records: MdnsRecord[] = []
        for (const a of [...packet.answers, ...packet.additionals]) {
          if (a.type === 'PTR') records.push({ kind: 'ptr', name: a.name, target: a.data })
          else if (a.type === 'A') records.push({ kind: 'a', name: a.name, address: a.data })
          else if (a.type === 'SRV')
            records.push({ kind: 'srv', name: a.name, port: a.data.port, target: a.data.target })
          else if (a.type === 'TXT') {
            const raw = Array.isArray(a.data) ? a.data : [a.data]
            records.push({ kind: 'txt', name: a.name, entries: raw.map((e) => e.toString()) })
          }
        }
        listener({ records, from: rinfo.address })
      })
    },
    onError: (listener) => {
      socket.on('error', listener)
    },
    query: (name) => socket.query({ questions: [{ name, type: 'PTR' }] }),
    destroy: () => socket.destroy(),
  }
}

function parseTxt(entries: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at > 0) out.set(entry.slice(0, at), entry.slice(at + 1))
  }
  return out
}

function originOf(value: string | undefined): string | null {
  if (value === undefined) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Fold the responses into hubs. Pure, so it is tested without sockets. */
export function hubsFromResponses(responses: readonly MdnsResponse[]): readonly MdnsHub[] {
  const found = new Map<string, MdnsHub>()
  for (const { records, from } of responses) {
    for (const ptr of records) {
      if (ptr.kind !== 'ptr') continue
      const srv = records.find((r) => r.kind === 'srv' && r.name === ptr.target)
      if (srv?.kind !== 'srv') continue
      const txtRecord = records.find((r) => r.kind === 'txt' && r.name === ptr.target)
      const txt =
        txtRecord?.kind === 'txt' ? parseTxt(txtRecord.entries) : new Map<string, string>()
      // A service that is not a hub is not ours to list.
      const role = txt.get(HUB_MDNS_TXT_KEYS.role)
      if (role !== undefined && role !== HUB_MDNS_ROLE) continue
      const a = records.find((r) => r.kind === 'a' && r.name === srv.target)
      const host = a?.kind === 'a' ? a.address : from
      // The advertised URL is the hub's own answer (its `internal` address);
      // the A record and the packet's source are the fallback.
      const url = originOf(txt.get(HUB_MDNS_TXT_KEYS.url)) ?? `https://${host}:${srv.port}`
      found.set(url, {
        url,
        nodeId: txt.get(HUB_MDNS_TXT_KEYS.nodeId) ?? null,
        version: txt.get(HUB_MDNS_TXT_KEYS.version) ?? null,
      })
    }
  }
  return [...found.values()]
}

/** Listen for `_camstack._tcp` for `timeoutMs`; never throws (no multicast = no hubs). */
export async function browseHubsMdns(options: BrowseOptions): Promise<readonly MdnsHub[]> {
  const responses: MdnsResponse[] = []
  const problem = (error: unknown): void =>
    options.onProblem?.(error instanceof Error ? error.message : String(error))
  let socket: MdnsSocket
  try {
    socket = (options.createSocket ?? createRealMdnsSocket)()
  } catch (err: unknown) {
    problem(err)
    return []
  }
  let requery: NodeJS.Timeout | null = null
  try {
    socket.onResponse((r) => responses.push(r))
    socket.onError(problem)
    socket.query(HUB_MDNS_QUERY_NAME)
    requery = setInterval(() => socket.query(HUB_MDNS_QUERY_NAME), options.requeryMs ?? 1000)
    await new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs))
  } catch (err: unknown) {
    problem(err)
  } finally {
    if (requery !== null) clearInterval(requery)
    socket.destroy()
  }
  return hubsFromResponses(responses)
}
