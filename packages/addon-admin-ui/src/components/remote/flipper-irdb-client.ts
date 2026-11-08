/**
 * On-demand reader of the Flipper-IRDB community library (CC0): a directory
 * listing through the GitHub contents API and a file through the raw host.
 * Nothing is mirrored or bundled; a listing is kept in memory for a few
 * minutes so browsing back and forth costs no request. GitHub is public and
 * unauthenticated, so a request can be refused for rate: that comes back as a
 * typed `rate-limited` error the panel shows.
 */
import { z } from 'zod'

const REPO = 'Lucaslhm/Flipper-IRDB'
const BRANCH = 'main'
const DEFAULT_TTL_MS = 10 * 60 * 1000

export type FlipperIrdbErrorCode = 'rate-limited' | 'not-found' | 'network' | 'bad-response'

export class FlipperIrdbError extends Error {
  readonly code: FlipperIrdbErrorCode
  /** When the rate limit lifts, in epoch milliseconds, if GitHub said. */
  readonly resetAtMs: number | null

  constructor(code: FlipperIrdbErrorCode, message: string, resetAtMs: number | null = null) {
    super(message)
    this.name = 'FlipperIrdbError'
    this.code = code
    this.resetAtMs = resetAtMs
  }
}

export interface FlipperIrdbEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'dir' | 'file'
}

const ListingSchema = z.array(z.object({ name: z.string(), path: z.string(), type: z.string() }))

export interface FlipperIrdbClientOptions {
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  readonly ttlMs?: number
}

export interface FlipperIrdbClient {
  /** Folders first, then `.ir` files, each sorted by name. */
  list(path: string): Promise<readonly FlipperIrdbEntry[]>
  readFile(path: string): Promise<string>
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/')
}

function entriesOf(raw: z.infer<typeof ListingSchema>): FlipperIrdbEntry[] {
  const entries: FlipperIrdbEntry[] = []
  for (const item of raw) {
    if (item.type === 'dir') entries.push({ name: item.name, path: item.path, kind: 'dir' })
    else if (item.type === 'file' && item.name.toLowerCase().endsWith('.ir')) {
      entries.push({ name: item.name, path: item.path, kind: 'file' })
    }
  }
  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  )
}

export function filterEntries(
  entries: readonly FlipperIrdbEntry[],
  query: string,
): readonly FlipperIrdbEntry[] {
  const needle = query.trim().toLowerCase()
  return needle === '' ? entries : entries.filter((e) => e.name.toLowerCase().includes(needle))
}

export function createFlipperIrdbClient(options: FlipperIrdbClientOptions = {}): FlipperIrdbClient {
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<
    string,
    { readonly at: number; readonly entries: readonly FlipperIrdbEntry[] }
  >()

  async function get(url: string): Promise<Response> {
    let response: Response
    try {
      response = await fetchFn(url)
    } catch (err: unknown) {
      throw new FlipperIrdbError('network', err instanceof Error ? err.message : 'request failed')
    }
    if (response.status === 404) throw new FlipperIrdbError('not-found', 'Not found in the library')
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0'
    if (response.status === 429 || (response.status === 403 && exhausted)) {
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      throw new FlipperIrdbError(
        'rate-limited',
        'GitHub rate limit reached',
        Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
      )
    }
    if (!response.ok)
      throw new FlipperIrdbError('bad-response', `GitHub answered ${response.status}`)
    return response
  }

  return {
    async list(path) {
      const key = encodePath(path)
      const hit = cache.get(key)
      if (hit !== undefined && now() - hit.at <= ttlMs) return hit.entries
      const response = await get(`https://api.github.com/repos/${REPO}/contents/${key}`)
      const parsed = ListingSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) throw new FlipperIrdbError('bad-response', 'Not a directory listing')
      const entries = entriesOf(parsed.data)
      cache.set(key, { at: now(), entries })
      return entries
    },
    async readFile(path) {
      const response = await get(
        `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${encodePath(path)}`,
      )
      return response.text()
    },
  }
}
