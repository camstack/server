/**
 * Hub candidates shared by every client that looks for a hub (D838, D839): the
 * CLI's `login` / `discover` and the agent's local UI. Candidates come from
 * what the LAN announces over mDNS plus whatever the caller already knows
 * (cached sessions for the CLI, the configured hub address for an agent); each
 * is probed on its https port, unreachable ones are dropped, the rest are
 * deduped by host:port with every source that named them kept.
 */
import { type BrowseOptions, browseHubsMdns, type MdnsHub } from './mdns-browse.js'

const DEFAULT_HTTPS_PORT = 443
const PROBE_TIMEOUT_MS = 1500
const DEFAULT_MDNS_TIMEOUT_MS = 3_000
export const MDNS_SOURCE_LABEL = 'LAN (mDNS)'

/** One reachable hub and everything that said so. */
export interface HubCandidate {
  /** `https://host:port`, the dedupe key's origin. */
  readonly url: string
  readonly host: string
  readonly port: number
  readonly nodeId: string | null
  readonly version: string | null
  /** Human labels: "LAN (mDNS)", "saved session admin", "CAMSTACK_HUB_URL"… */
  readonly sources: readonly string[]
}

/** A hub some source named, before it is probed. */
export interface RawCandidate {
  readonly url: string
  readonly source: string
  readonly nodeId?: string | null
  readonly version?: string | null
}

export interface DiscoverHubsDeps {
  /** Hubs the caller already knows, each tagged with where it learned it. */
  readonly known?: readonly RawCandidate[]
  readonly browse?: (options: BrowseOptions) => Promise<readonly MdnsHub[]>
  readonly probe?: (host: string, port: number) => Promise<boolean>
  readonly mdnsTimeoutMs?: number
  readonly onProblem?: (message: string) => void
}

/** `https://host:port` for any URL-ish string; null when it is not an http(s) URL. */
export function normalizeHubUrl(value: string): { url: string; host: string; port: number } | null {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.hostname === '') return null
  const port = parsed.port === '' ? DEFAULT_HTTPS_PORT : Number.parseInt(parsed.port, 10)
  // A hub is reached over https; an http URL is probed on its https sibling only
  // when it names a port, so keep the host:port as written.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const shown = host.includes(':') ? `[${host}]` : host
  return { url: `https://${shown}:${port}`, host, port }
}

/** Merge raw candidates by host:port, keeping every source and any identity. */
export function mergeCandidates(raw: readonly RawCandidate[]): readonly HubCandidate[] {
  const merged = new Map<string, HubCandidate>()
  for (const r of raw) {
    const n = normalizeHubUrl(r.url)
    if (n === null) continue
    const key = `${n.host}:${n.port}`
    const prev = merged.get(key)
    merged.set(key, {
      url: n.url,
      host: n.host,
      port: n.port,
      nodeId: prev?.nodeId ?? r.nodeId ?? null,
      version: prev?.version ?? r.version ?? null,
      sources: prev?.sources.includes(r.source)
        ? prev.sources
        : [...(prev?.sources ?? []), r.source],
    })
  }
  return [...merged.values()]
}

/** The hubs worth offering: announced or known, deduped, and answering on https. */
export async function discoverHubs(deps: DiscoverHubsDeps = {}): Promise<readonly HubCandidate[]> {
  const browse = deps.browse ?? browseHubsMdns
  const probe = deps.probe ?? probeHttps
  const announced = await browse({
    timeoutMs: deps.mdnsTimeoutMs ?? DEFAULT_MDNS_TIMEOUT_MS,
    ...(deps.onProblem ? { onProblem: deps.onProblem } : {}),
  })
  const raw: readonly RawCandidate[] = [
    ...announced.map((h) => ({
      url: h.url,
      source: MDNS_SOURCE_LABEL,
      nodeId: h.nodeId,
      version: h.version,
    })),
    ...(deps.known ?? []),
  ]
  const candidates = mergeCandidates(raw)
  const verdicts = await Promise.all(candidates.map((c) => probe(c.host, c.port)))
  return candidates.filter((_, i) => verdicts[i] === true)
}

/**
 * HEAD probe with a short timeout. `rejectUnauthorized: false` is intentional —
 * hubs serve a private-CA certificate and this only asks "is something
 * answering https here"; no credential is ever sent.
 */
export async function probeHttps(host: string, port: number): Promise<boolean> {
  const { request } = await import('node:https')
  return new Promise<boolean>((resolve) => {
    const req = request(
      {
        host,
        port,
        method: 'HEAD',
        path: '/trpc/health',
        timeout: PROBE_TIMEOUT_MS,
        rejectUnauthorized: false,
      },
      (res) => {
        resolve(typeof res.statusCode === 'number')
        res.resume()
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}
