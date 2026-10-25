/**
 * Site location — the installation's coordinates, as a fact of the SITE.
 *
 * ## Why this is not an addon setting
 *
 * Latitude and longitude used to live in `pipeline-analytics`' global settings,
 * because scene monitoring was the first thing to need sun-times. That made a
 * property of the *building* a property of one analytics addon: a second
 * consumer would either import the first addon's key (addons never import each
 * other) or grow a second knob that disagrees with it — the mistake
 * [D62](../../../../../docs/decisions/adr-0062.md) records. It lives here, on
 * the hub, behind `system.getSiteLocation`, and every consumer reads that one
 * authority over the transport.
 *
 * ## The default, and why it is derived exactly once
 *
 * With no coordinates the sun-times consumers fall back to a coarse **UTC**
 * clock split, which is wrong by an hour or two at the edges for most of
 * Europe. A hub can do better without asking: its public IP geolocates to
 * within a few kilometres, which is far below the resolution sunrise needs.
 *
 * So the FIRST read that finds nothing stored derives one — and the derivation
 * is one-shot in the strong sense:
 *
 *   - one outbound request, `GEO_IP_TIMEOUT_MS` bounded, single-flighted so
 *     concurrent readers share it;
 *   - the OUTCOME is persisted either way. A success stores the coordinates
 *     with `source: 'derived-from-ip'`; a failure stores
 *     `derivationAttemptedAt` + `derivationError` and nothing ever retries on a
 *     read path again. A hub with no internet pays four seconds once, in its
 *     entire life;
 *   - nothing gates on it. Boot does not wait for it, and a caller that finds
 *     `location: null` degrades exactly as it did before this module existed.
 *
 * The only retry is an operator pressing detect (`detectSiteLocation`). That is
 * deliberate: an automatic retry loop against a third-party service is how a
 * homelab ends up rate-limited, and the value it would eventually fetch is one
 * the operator can type in five seconds.
 *
 * ## Provenance is part of the value
 *
 * `source` distinguishes a guess from an operator's input, and the UI shows it.
 * An operator who cannot tell the two apart will eventually trust the guess —
 * and a derivation must never overwrite a typed value, which is why
 * `SiteLocationService.detect` refuses when `source === 'operator-set'`.
 */

import type { IScopedLogger } from '@camstack/types'
import { errMsg, type SiteLocationStatus } from '@camstack/types'

/** The `system-settings` row this module owns. */
export const SITE_LOCATION_KEY = 'site-location'

const SYSTEM_SETTINGS_COLLECTION = 'system-settings'

/**
 * The addon store the coordinates used to live in. Read ONCE, lazily, to
 * migrate an operator who already typed them — see {@link readLegacyAddonCoordinates}.
 */
const LEGACY_ADDON_NAMESPACE = 'pipeline-analytics'
const LEGACY_ADDON_COLLECTION = 'addon-settings'
const LEGACY_ADDON_KEY = 'root'
const LEGACY_LAT_KEY = 'siteLatitude'
const LEGACY_LNG_KEY = 'siteLongitude'

/**
 * Bound on the geo-IP request. Short on purpose: this sits on the first read of
 * a lazily-derived default, so it is latency an operator can feel. Four seconds
 * is long enough for a cold TLS handshake to a CDN and short enough that a
 * captive-portal black hole does not look like a hang.
 */
export const GEO_IP_TIMEOUT_MS = 4_000

/**
 * No-key, HTTPS geo-IP endpoints, tried in order until one parses.
 *
 * Both answer an unauthenticated GET with the caller's own public IP resolved
 * to a city centroid. Neither is contacted unless a derivation actually runs,
 * and the request carries nothing but the hub's IP — which the endpoint would
 * see regardless, since seeing it is the entire mechanism.
 */
export const GEO_IP_ENDPOINTS: readonly string[] = [
  'https://ipinfo.io/json',
  'https://ipapi.co/json/',
]

export interface GeoIpFix {
  readonly latitude: number
  readonly longitude: number
  /** Display-only place name, when the service supplied one. */
  readonly label?: string
}

/** The persisted row shape. Every field optional — an older row must still read. */
export interface SiteLocationRecord {
  readonly latitude?: number
  readonly longitude?: number
  readonly source?: 'operator-set' | 'derived-from-ip'
  readonly updatedAt?: number
  readonly label?: string
  readonly derivationAttemptedAt?: number
  readonly derivationError?: string
}

/** The two calls this module needs from the settings-store cap, over the broker. */
export interface SettingsStoreGateway {
  get(input: { namespace?: string; collection: string; key: string }): Promise<unknown>
  set(input: { namespace?: string; collection: string; key: string; value: unknown }): Promise<void>
}

export type GeoIpFetch = (url: string, init: RequestInit) => Promise<Response>

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * `(0, 0)` is Null Island, not a homelab. Anything non-finite or out of range
 * is treated as absent rather than clamped: a wrong-but-plausible coordinate
 * produces a wrong sunrise silently, which is worse than the declared fallback.
 */
export function isUsableCoordinate(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false
  return lat !== 0 || lng !== 0
}

/** Project a stored row onto the wire shape. */
export function toStatus(record: SiteLocationRecord | null): SiteLocationStatus {
  if (record === null) {
    return { location: null, derivationAttemptedAt: null, derivationError: null }
  }
  const attempted = typeof record.derivationAttemptedAt === 'number'
  const status: SiteLocationStatus = {
    location: isUsableCoordinate(record.latitude, record.longitude)
      ? {
          // The guard above proves both are numbers; the narrowing does not
          // survive the property read, so re-assert with a finite fallback
          // rather than a cast.
          latitude: Number(record.latitude),
          longitude: Number(record.longitude),
          source: record.source === 'operator-set' ? 'operator-set' : 'derived-from-ip',
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
          ...(record.label !== undefined ? { label: record.label } : {}),
        }
      : null,
    derivationAttemptedAt: attempted ? Number(record.derivationAttemptedAt) : null,
    derivationError: typeof record.derivationError === 'string' ? record.derivationError : null,
  }
  return status
}

function asRecord(raw: unknown): SiteLocationRecord | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  const record: SiteLocationRecord = {
    ...(typeof obj['latitude'] === 'number' ? { latitude: obj['latitude'] } : {}),
    ...(typeof obj['longitude'] === 'number' ? { longitude: obj['longitude'] } : {}),
    ...(obj['source'] === 'operator-set' || obj['source'] === 'derived-from-ip'
      ? { source: obj['source'] }
      : {}),
    ...(typeof obj['updatedAt'] === 'number' ? { updatedAt: obj['updatedAt'] } : {}),
    ...(typeof obj['label'] === 'string' ? { label: obj['label'] } : {}),
    ...(typeof obj['derivationAttemptedAt'] === 'number'
      ? { derivationAttemptedAt: obj['derivationAttemptedAt'] }
      : {}),
    ...(typeof obj['derivationError'] === 'string'
      ? { derivationError: obj['derivationError'] }
      : {}),
  }
  return record
}

/**
 * Parse either supported geo-IP payload.
 *
 * `ipinfo.io` answers `{ loc: "40.8518,14.2681", city, region, country }`;
 * `ipapi.co` answers `{ latitude, longitude, city, country_code }`. Both are
 * handled here rather than behind two adapters because the whole difference is
 * three field names, and an adapter per vendor is how a 30-line fetch becomes a
 * folder.
 */
export function parseGeoIpPayload(payload: unknown): GeoIpFix | null {
  if (payload === null || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>

  let lat: unknown = obj['latitude']
  let lng: unknown = obj['longitude']

  const loc = obj['loc']
  if (typeof loc === 'string') {
    const [rawLat, rawLng] = loc.split(',')
    if (rawLat !== undefined && rawLng !== undefined) {
      lat = Number(rawLat)
      lng = Number(rawLng)
    }
  }

  if (!isUsableCoordinate(lat, lng)) return null

  const city = obj['city']
  const country = obj['country'] ?? obj['country_code']
  const parts = [city, country].filter((p): p is string => typeof p === 'string' && p.length > 0)

  return {
    latitude: Number(lat),
    longitude: Number(lng),
    ...(parts.length > 0 ? { label: parts.join(', ') } : {}),
  }
}

/**
 * One pass over {@link GEO_IP_ENDPOINTS}. Returns the first fix that parses.
 *
 * Every failure mode collapses to `null` plus a log line: this is a *default*,
 * and a default that throws would take down whatever asked for it.
 */
export async function geolocatePublicIp(
  fetchImpl: GeoIpFetch,
  logger?: IScopedLogger,
  endpoints: readonly string[] = GEO_IP_ENDPOINTS,
): Promise<GeoIpFix | null> {
  for (const url of endpoints) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(GEO_IP_TIMEOUT_MS),
      })
      if (!response.ok) {
        logger?.debug('geo-IP endpoint refused', { meta: { url, status: response.status } })
        continue
      }
      const fix = parseGeoIpPayload(await response.json())
      if (fix !== null) return fix
      logger?.debug('geo-IP endpoint answered without usable coordinates', { meta: { url } })
    } catch (err: unknown) {
      logger?.debug('geo-IP endpoint failed', { meta: { url, error: errMsg(err) } })
    }
  }
  return null
}

// ── the service ─────────────────────────────────────────────────────────────

export interface SiteLocationServiceDeps {
  readonly store: SettingsStoreGateway
  readonly fetchImpl?: GeoIpFetch
  readonly logger?: IScopedLogger
  readonly now?: () => number
}

/**
 * Reads and writes the site location, owning the one-shot derivation.
 *
 * Constructed per request by `buildSystemProvider` — the single-flight promise
 * therefore bounds concurrent readers *within* a request, and the persisted
 * `derivationAttemptedAt` bounds them across requests and across restarts. The
 * durable marker is the real guarantee; the in-process one only stops a burst.
 */
export class SiteLocationService {
  private static inFlight: Promise<SiteLocationStatus> | null = null

  constructor(private readonly deps: SiteLocationServiceDeps) {}

  /** Test seam: the static single-flight outlives a request by design. */
  static __resetForTests(): void {
    SiteLocationService.inFlight = null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async read(): Promise<SiteLocationRecord | null> {
    try {
      return asRecord(
        await this.deps.store.get({
          collection: SYSTEM_SETTINGS_COLLECTION,
          key: SITE_LOCATION_KEY,
        }),
      )
    } catch (err: unknown) {
      // A failed READ must never look like "not configured" — that would send
      // the derivation off to overwrite a value that exists. Rethrow-as-null is
      // exactly the D49 shape this repo has been bitten by, so the caller is
      // told instead.
      this.deps.logger?.warn('site location read failed', { meta: { error: errMsg(err) } })
      throw err
    }
  }

  private async write(record: SiteLocationRecord): Promise<void> {
    await this.deps.store.set({
      collection: SYSTEM_SETTINGS_COLLECTION,
      key: SITE_LOCATION_KEY,
      value: record,
    })
  }

  /**
   * The coordinates an operator already typed into `pipeline-analytics`, if any.
   *
   * Lazy migration, read once on the first system-level read that finds nothing:
   * those numbers are `operator-set` by definition, and deriving over them would
   * silently replace a deliberate value with a guess. A failure here is not
   * fatal — it just means the derivation runs.
   */
  private async readLegacyAddonCoordinates(): Promise<GeoIpFix | null> {
    try {
      const raw = await this.deps.store.get({
        namespace: LEGACY_ADDON_NAMESPACE,
        collection: LEGACY_ADDON_COLLECTION,
        key: LEGACY_ADDON_KEY,
      })
      if (raw === null || typeof raw !== 'object') return null
      const obj = raw as Record<string, unknown>
      const lat = Number(obj[LEGACY_LAT_KEY])
      const lng = Number(obj[LEGACY_LNG_KEY])
      if (!isUsableCoordinate(lat, lng)) return null
      return { latitude: lat, longitude: lng }
    } catch (err: unknown) {
      this.deps.logger?.debug('legacy site coordinates read failed', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Current value, deriving a default on the first read that finds nothing.
   *
   * Order: stored value → already-attempted marker (stop, no retry) → lazy
   * migration from the old addon setting → geo-IP.
   */
  async get(): Promise<SiteLocationStatus> {
    const record = await this.read()
    if (record !== null && isUsableCoordinate(record.latitude, record.longitude)) {
      return toStatus(record)
    }
    if (record !== null && typeof record.derivationAttemptedAt === 'number') {
      // Spent. `detectSiteLocation` is the only way back.
      return toStatus(record)
    }

    const existing = SiteLocationService.inFlight
    if (existing !== null) return existing

    const run = this.deriveDefault().finally(() => {
      SiteLocationService.inFlight = null
    })
    SiteLocationService.inFlight = run
    return run
  }

  private async deriveDefault(): Promise<SiteLocationStatus> {
    const legacy = await this.readLegacyAddonCoordinates()
    if (legacy !== null) {
      this.deps.logger?.info(
        'site location migrated from the pipeline-analytics addon setting — operator-set',
      )
      return this.persist(legacy, 'operator-set')
    }
    return this.derive()
  }

  /**
   * Run the geo-IP lookup and persist the outcome — success or failure.
   *
   * Persisting the FAILURE is the point: without it every read retries, which
   * is a request per scene check against a free third-party endpoint.
   */
  private async derive(): Promise<SiteLocationStatus> {
    const fetchImpl = this.deps.fetchImpl ?? ((url, init) => fetch(url, init))
    const fix = await geolocatePublicIp(fetchImpl, this.deps.logger)
    if (fix !== null) {
      this.deps.logger?.info('site location derived from the public IP', {
        meta: { label: fix.label ?? 'unknown', source: 'derived-from-ip' },
      })
      return this.persist(fix, 'derived-from-ip')
    }
    const failure: SiteLocationRecord = {
      derivationAttemptedAt: this.now(),
      derivationError: 'no geo-IP endpoint answered with usable coordinates',
    }
    // A branch that DROPS a default silently reads as "never happened".
    this.deps.logger?.warn(
      'site location could not be derived from the public IP — consumers fall back to the UTC clock split until an operator sets it. This will NOT be retried automatically.',
    )
    try {
      await this.write(failure)
    } catch (err: unknown) {
      // The marker is what makes it one-shot. Losing it costs a retry on the
      // next read, never a wrong value.
      this.deps.logger?.warn('site location failure marker could not be persisted', {
        meta: { error: errMsg(err) },
      })
    }
    return toStatus(failure)
  }

  private async persist(
    fix: GeoIpFix,
    source: 'operator-set' | 'derived-from-ip',
  ): Promise<SiteLocationStatus> {
    const record: SiteLocationRecord = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      source,
      updatedAt: this.now(),
      ...(fix.label !== undefined ? { label: fix.label } : {}),
      derivationAttemptedAt: this.now(),
    }
    await this.write(record)
    return toStatus(record)
  }

  /** Operator input. Clears the value when `input` is `null`. */
  async set(input: { latitude: number; longitude: number } | null): Promise<SiteLocationStatus> {
    if (input === null) {
      // The derivation stays spent: clearing means "I do not want coordinates",
      // not "guess again". Detect is the button for that.
      const cleared: SiteLocationRecord = { derivationAttemptedAt: this.now() }
      await this.write(cleared)
      return toStatus(cleared)
    }
    return this.persist({ latitude: input.latitude, longitude: input.longitude }, 'operator-set')
  }

  /**
   * Explicit re-derivation. The only retry path.
   *
   * Refuses to overwrite an `operator-set` value — a detect button next to a
   * typed coordinate must not be able to destroy it by mis-click. The operator
   * clears first, then detects.
   */
  async detect(): Promise<SiteLocationStatus> {
    const record = await this.read()
    if (
      record !== null &&
      record.source === 'operator-set' &&
      isUsableCoordinate(record.latitude, record.longitude)
    ) {
      this.deps.logger?.info('site location detect skipped — an operator-set value already exists')
      return toStatus(record)
    }
    return this.derive()
  }
}
