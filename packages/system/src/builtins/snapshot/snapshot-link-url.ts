/**
 * Signed, expiring links to a CLIENT-SIZED snapshot frame.
 *
 * ## Why a link plane exists at all
 *
 * The authenticated `/addon/snapshot/media/<id>.jpg` plane works, and it is not
 * going away. What it cannot do is guarantee that a client asking for a tile
 * actually REACHES the server — and that turned out to be the whole bug.
 *
 * Under D93 the image URL is versioned by the frame identity, and an image
 * request is what signalled demand for a camera. Both halves are satisfied by
 * the client's own image cache: `expo-image` is URL-keyed and never
 * revalidates, so a URL the app painted in a previous session is served from
 * disk with **zero network**. Measured on the live hub, reopening the app after
 * two minutes idle painted 15 of 16 tiles from disk — frames **168 s old**, with
 * not one HTTP request, therefore no demand, therefore no capture. The
 * operator's report ("gli snapshot sono vecchi, devo aggiornare più volte" [the snapshots are old, I have to refresh several times]) is
 * that measurement.
 *
 * That gap used to be covered on BOTH sides — by this link plane and by a
 * server-side keep-warm timer. The timer was removed on 2026-08-11 (operator
 * directive: snapshots are on-demand, always), which makes this plane the only
 * thing standing between a client cache and a frozen tile. It carries the whole
 * job now.
 *
 * A minted link breaks the loop from both ends. It is produced by an RPC —
 * `snapshot.getSnapshotLinks` — which no image cache can answer, so the demand
 * signal always lands; and it carries the capture identity the RPC just WAITED
 * for, rather than one a cache-only poll happened to be holding.
 *
 * ## What is signed, and what is only a cache key
 *
 * The signature covers `"<deviceId>:<width>"` and the expiry. The width is
 * inside it deliberately: a leaked 240 px tile link must not be replayable as a
 * request for the full 4 K frame. `v` (the capture identity) is NOT signed — it
 * exists only to key the client's image cache, so an unchanged frame is a
 * byte-identical URL and costs no bytes, and a new frame is a new URL and costs
 * exactly one fetch.
 *
 * `exp` is bucketed rather than exact. A URL that were unique per mint would
 * defeat the client cache completely — correct for freshness, and it would make
 * a phone re-download every tile on every 5 s poll whether or not anything
 * changed. Bucketing means the URL moves when the FRAME moves, and otherwise at
 * most once per bucket.
 *
 * Pure and side-effect-free; the addon owns the secret and the clock. Unit
 * tested in `__tests__/snapshot-link-url.spec.ts`.
 */
import { signExpiringUrl, verifyExpiringUrl } from '@camstack/types/node'

/**
 * How long a minted link stays valid.
 *
 * A snapshot is a live view of the operator's home, so this is short on purpose
 * — the exposure of a leaked link is bounded by it. Two minutes is long enough
 * that a page renders, re-renders and survives a brief backgrounding on the URL
 * it was given, and short enough that a link pasted somewhere is dead before it
 * is useful. The client re-mints on every overview poll (5 s), so it never
 * depends on the tail of this window.
 */
export const SNAPSHOT_LINK_TTL_MS = 120_000

/**
 * Quantum the expiry is rounded UP to, so a link is stable between mints.
 *
 * Without it every mint produces a different `exp`, hence a different URL, hence
 * a full re-download of an unchanged frame on every poll. With it the URL is a
 * pure function of (device, width, frame, bucket) — so a tile fetches when its
 * frame moves, and at most once more per bucket.
 */
export const SNAPSHOT_LINK_EXP_BUCKET_MS = 30_000

/** The token the signature is computed over. Width is part of the identity so a
 *  tile link cannot be escalated into a full-frame request. */
export function snapshotLinkId(deviceId: number, width: number | undefined): string {
  return `${String(deviceId)}:${width === undefined ? 'full' : String(width)}`
}

/** The bucketed expiry for a link minted at `nowMs`. Always ≥ `nowMs + TTL`. */
export function snapshotLinkExpiry(
  nowMs: number,
  ttlMs: number = SNAPSHOT_LINK_TTL_MS,
  bucketMs: number = SNAPSHOT_LINK_EXP_BUCKET_MS,
): number {
  return Math.ceil((nowMs + ttlMs) / bucketMs) * bucketMs
}

export interface BuildSnapshotLinkInput {
  /** Root-relative plane prefix, e.g. `/addon/snapshot/link`. */
  readonly routePrefix: string
  readonly deviceId: number
  /** Snapped ladder rung the bytes will be at, or undefined for the full frame. */
  readonly width: number | undefined
  /** Capture identity of the frame this link names — the client's cache key. */
  readonly capturedAt: number | null
  readonly secret: string
  readonly expMs: number
}

/**
 * The link, as a ROOT-RELATIVE path.
 *
 * Deliberately not absolute. The artifact and HA planes must mint absolute URLs
 * because the fetcher is a phone or a notifier backend that has no idea where
 * the hub is — and picking that base is the `hubUrl: localhost` trap the Alexa
 * work paid for. Here the fetcher is a client that is already connected to the
 * hub and holds its own `serverUrl`, so the correct base is the one it used to
 * make the call. Returning a path makes it impossible to hand a client a link
 * pointing somewhere it cannot reach.
 */
export function buildSnapshotLinkUrl(input: BuildSnapshotLinkInput): string {
  const prefix = input.routePrefix.startsWith('/') ? input.routePrefix : `/${input.routePrefix}`
  const base = prefix.replace(/\/+$/, '')
  const id = snapshotLinkId(input.deviceId, input.width)
  const sig = signExpiringUrl(input.secret, id, input.expMs)
  const params = new URLSearchParams()
  if (input.width !== undefined) params.set('w', String(input.width))
  if (input.capturedAt !== null) params.set('v', String(input.capturedAt))
  params.set('exp', String(input.expMs))
  params.set('sig', sig)
  return `${base}/${String(input.deviceId)}.jpg?${params.toString()}`
}

/** A verified link request. `width` is the SIGNED width, never the raw query. */
export interface ParsedSnapshotLink {
  readonly deviceId: number
  readonly width: number | undefined
}

export interface ParseSnapshotLinkInput {
  /** Handler-relative url, e.g. `/101.jpg?w=240&exp=…&sig=…`. */
  readonly url: string
  readonly secret: string
  readonly nowMs: number
}

/**
 * Parse and VERIFY a link request in one step, so a caller cannot accidentally
 * use the device id before checking the signature. Null = refuse (404/403);
 * there is deliberately no way to distinguish "bad signature" from "expired"
 * from "malformed" at this boundary, so a public route cannot be probed.
 */
export function parseVerifiedSnapshotLink(
  input: ParseSnapshotLinkInput,
): ParsedSnapshotLink | null {
  const qIdx = input.url.indexOf('?')
  const rawPath = qIdx === -1 ? input.url : input.url.slice(0, qIdx)
  const query = qIdx === -1 ? '' : input.url.slice(qIdx + 1)
  const segment = rawPath.replace(/^\/+/, '')
  if (segment.length === 0 || segment.includes('/')) return null
  const idPart = segment.replace(/\.jpe?g$/i, '')
  if (!/^\d+$/.test(idPart)) return null
  const deviceId = Number.parseInt(idPart, 10)
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) return null

  const params = new URLSearchParams(query)
  const rawWidth = params.get('w')
  // The width is part of the signed identity, so it is taken VERBATIM and never
  // re-snapped here: snapping a tampered value would compute a different id than
  // the one signed and merely produce a confusing refusal, and accepting an
  // unsigned width would let a tile link fetch the full frame.
  if (rawWidth !== null && !/^\d+$/.test(rawWidth)) return null
  const width = rawWidth === null ? undefined : Number.parseInt(rawWidth, 10)
  if (width !== undefined && (!Number.isSafeInteger(width) || width <= 0)) return null

  const ok = verifyExpiringUrl({
    secret: input.secret,
    id: snapshotLinkId(deviceId, width),
    exp: params.get('exp') ?? undefined,
    sig: params.get('sig') ?? undefined,
    nowMs: input.nowMs,
  })
  return ok ? { deviceId, width } : null
}
