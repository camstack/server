/**
 * The viewer role's hub list: identity, session partition, and the pinned
 * root-CA fingerprint per hub.
 *
 * All of it is PURE — the record is a plain JSON object the caller reads out of
 * `electron-store` and writes back. No credentials are ever stored here: a hub
 * entry is a URL, a label, and the SHA-256 fingerprint of the root the operator
 * confirmed once (see `cert-trust.ts` and ADR-0402). The session cookie lives in
 * the partition's own jar; the bearer token lives in the SPA's localStorage on
 * the hub origin.
 *
 * The hub id is derived from the ORIGIN, not from a counter, so the same hub
 * typed twice reuses one partition (and therefore one login) and a different
 * hub can never inherit another's cookies or pin.
 */

/** One configured hub. */
export interface HubEntry {
  /** Stable id derived from the origin — also the partition suffix. */
  readonly id: string
  /** The origin the window loads from, e.g. `https://192.168.10.9:4443`. */
  readonly origin: string
  /** Operator-facing label; defaults to the origin. */
  readonly label: string
  /**
   * SHA-256 fingerprint of the issuer (D227 root CA) the operator confirmed,
   * or `null` while this hub has never been trusted.
   */
  readonly pinnedIssuerFingerprint: string | null
}

/** The persisted shape: hubs by id + which one is active. */
export interface HubRecord {
  readonly hubs: readonly HubEntry[]
  readonly activeHubId: string | null
}

export const EMPTY_HUB_RECORD: HubRecord = { hubs: [], activeHubId: null }

/**
 * Normalise a typed hub URL to its ORIGIN. Returns null when the input is not a
 * usable absolute http(s) URL — the setup window refuses to save that.
 */
export function normalizeHubOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  // A scheme that is present but not http(s) is a typo, not something to
  // "helpfully" prefix — `https://ftp://hub` parses, and to the wrong origin.
  if (scheme !== null && !/^https?$/i.test(scheme[1] ?? '')) return null
  const candidate = scheme !== null ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname === '') return null
  return url.origin
}

/**
 * A filesystem/partition-safe id for an origin. `persist:` partition names end
 * up in a directory name, so anything but `[a-z0-9-]` is folded out.
 */
export function hubIdForOrigin(origin: string): string {
  return origin
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The Electron session partition for a hub — persistent, one jar per hub. */
export function partitionForHub(hubId: string): string {
  return `persist:hub-${hubId}`
}

/** The URL the viewer window loads for a hub. */
export function viewerUrlForOrigin(origin: string): string {
  return `${origin}/viewer/camstack/`
}

/** The cheap liveness probe — does not touch the SPA mount. */
export function healthUrlForOrigin(origin: string): string {
  return `${origin}/health`
}

export function findHub(record: HubRecord, hubId: string): HubEntry | null {
  return record.hubs.find((hub) => hub.id === hubId) ?? null
}

export function activeHub(record: HubRecord): HubEntry | null {
  return record.activeHubId === null ? null : findHub(record, record.activeHubId)
}

/**
 * Add (or re-select) a hub by origin and make it active. Immutable: returns a
 * new record. An origin already present keeps its pin — re-typing the same
 * address must not silently clear a trust decision.
 */
export function withActiveHubOrigin(record: HubRecord, origin: string, label?: string): HubRecord {
  const id = hubIdForOrigin(origin)
  const existing = findHub(record, id)
  if (existing !== null) {
    const relabelled: HubEntry =
      label === undefined || label === existing.label ? existing : { ...existing, label }
    return {
      hubs: record.hubs.map((hub) => (hub.id === id ? relabelled : hub)),
      activeHubId: id,
    }
  }
  const entry: HubEntry = {
    id,
    origin,
    label: label ?? origin,
    pinnedIssuerFingerprint: null,
  }
  return { hubs: [...record.hubs, entry], activeHubId: id }
}

/** Record the operator's trust decision for a hub. Immutable. */
export function withPinnedFingerprint(
  record: HubRecord,
  hubId: string,
  fingerprint: string,
): HubRecord {
  return {
    hubs: record.hubs.map((hub) =>
      hub.id === hubId ? { ...hub, pinnedIssuerFingerprint: fingerprint } : hub,
    ),
    activeHubId: record.activeHubId,
  }
}

/**
 * Clear a hub's pin. Used only by the explicit "forget this hub's certificate"
 * path — a MISMATCH never clears it on its own (ADR-0402).
 */
export function withClearedPin(record: HubRecord, hubId: string): HubRecord {
  return {
    hubs: record.hubs.map((hub) =>
      hub.id === hubId ? { ...hub, pinnedIssuerFingerprint: null } : hub,
    ),
    activeHubId: record.activeHubId,
  }
}
