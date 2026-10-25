import { createHash } from 'node:crypto'
import { Agent, fetch as undicicFetch } from 'undici'

export interface FetchBundleOpts {
  readonly url: string
  readonly token: string
  readonly sha256: string
  readonly bytes: number
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

/** Minimal response surface used by fetchBundleFromHub. */
interface ResponseLike {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * Stream a staged addon tgz from the hub's one-time-token bundle route and
 * verify integrity (byte count + sha256) before handing it to the installer.
 */
export async function fetchBundleFromHub(opts: FetchBundleOpts): Promise<Buffer> {
  // When a fetchImpl is injected (tests), call it as-is — the stub ignores dispatcher.
  // For production (global fetch against the real hub's self-signed TLS cert), use
  // undici.fetch with an Agent that disables CA verification. The hub serves HTTPS with a
  // self-signed cert; bare fetch rejects it with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
  // Integrity is independently guaranteed by the sha256+bytes checks below; trust is
  // established by the cluster relationship — consistent with the CLI's approach.
  //
  // We call undici.fetch (not the global fetch) so that `Agent` and `RequestInit` share
  // the same undici type declarations; the global fetch augmentation uses `undici-types`
  // which ships a structurally incompatible `Dispatcher` type. Both return a structurally
  // compatible Response; we narrow via the shared `ResponseLike` interface to avoid
  // cross-package type unification.
  // `accept-encoding: identity` — never let the hub gzip/brotli this binary
  // pull. A Brotli-encoded response made undici's BrotliDecompress abort with
  // "TypeError: terminated", silently breaking the pull. The hub also opts the
  // route out of compression; this is the client-side belt-and-suspenders.
  const authHeader = { Authorization: `Bearer ${opts.token}`, 'accept-encoding': 'identity' }
  const res: ResponseLike = opts.fetchImpl
    ? await opts.fetchImpl(opts.url, { headers: authHeader })
    : await undicicFetch(opts.url, {
        headers: authHeader,
        dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
      })
  if (!res.ok) {
    throw new Error(`bundle fetch failed: HTTP ${res.status}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length !== opts.bytes) {
    throw new Error(`bundle bytes mismatch: expected ${opts.bytes}, got ${buffer.length}`)
  }
  const sha = createHash('sha256').update(buffer).digest('hex')
  if (sha !== opts.sha256) {
    throw new Error(`bundle sha256 mismatch: expected ${opts.sha256}, got ${sha}`)
  }
  return buffer
}
