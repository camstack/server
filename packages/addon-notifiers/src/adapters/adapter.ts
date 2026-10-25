/**
 * The internal notifier seam.
 *
 * Every kind (ntfy, pushover, gotify, telegram, discord, webhook, zentik …)
 * is one `NotifierAdapter`. The provider (`src/provider.ts`) is the
 * multiplexer: it degrades the canonical notification with the pure
 * `prepareNotification` engine, fetches any `needsFetch` attachments, then
 * hands the adapter a fully-prepared message and asks it to shape ONE
 * `HttpRequestPlan`. `buildRequest` is PURE — it never touches the network;
 * the provider executes the plan. This keeps every adapter unit-testable by
 * asserting the exact url / headers / body it emits (no network in unit
 * tests — see `docs/superpowers/plans/2026-07-03-notification-output.md` T6–T12).
 */
import type {
  DiscoveredTarget,
  PreparedNotification,
  SendResult,
  TargetKind,
} from '@camstack/types'

/** At least one destination key — see {@link NotifierAdapter.destinationKeys}. */
export type DestinationKeys = readonly [string, ...string[]]

/** A target's stored configuration blob. Secret fields live here too. */
export type TargetConfig = Readonly<Record<string, unknown>>

// ── HTTP request plan (the pure output of `buildRequest`) ───────────

/** JSON body — serialised by the provider; `content-type: application/json` is added unless overridden. */
export interface JsonRequestBody {
  readonly kind: 'json'
  readonly value: unknown
}

/** Pre-rendered text body (e.g. a URL-encoded form or a plain string). */
export interface TextRequestBody {
  readonly kind: 'text'
  readonly value: string
  readonly contentType?: string
}

/** Raw binary body (single-attachment PUT uploads, protobuf, …). */
export interface RawRequestBody {
  readonly kind: 'raw'
  readonly value: Uint8Array
  readonly contentType?: string
}

/** One part of a multipart/form-data body. */
export type MultipartPart =
  | { readonly kind: 'field'; readonly name: string; readonly value: string }
  | {
      readonly kind: 'file'
      readonly name: string
      readonly bytes: Uint8Array
      readonly filename?: string
      readonly contentType?: string
    }

/** multipart/form-data body — used for attachment/byte uploads (Pushover, Telegram, Discord). */
export interface MultipartRequestBody {
  readonly kind: 'multipart'
  readonly parts: readonly MultipartPart[]
}

export type HttpRequestBody =
  | JsonRequestBody
  | TextRequestBody
  | RawRequestBody
  | MultipartRequestBody

/** A single outbound HTTP request, fully described but not yet executed. */
export interface HttpRequestPlan {
  readonly url: string
  /** Defaults to `POST` when omitted. */
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: HttpRequestBody
}

/**
 * The minimal response view an adapter's `parseResult` consumes. The provider
 * reads the body ONCE and hands it to `parseResult` as `bodyText`, so an
 * adapter can surface a provider's error JSON without touching the (async,
 * single-use) `text()` itself.
 */
export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

/**
 * Result of an optional pre-save credential probe (`getStateInstance`,
 * validate.json, …). `resolvedUrl` MUST omit secrets (no token in the path).
 */
export interface ProbeResult {
  readonly ok: boolean
  readonly resolvedUrl: string
  readonly httpStatus?: number
  readonly stateInstance?: string
  readonly error?: string
}

/**
 * One notifier kind. `descriptor` declares the kind's capabilities +
 * `configSchema`; `buildRequest` maps a prepared notification onto a wire
 * request; `parseResult` (optional) interprets the response; `discover`
 * (optional) surfaces adoptable candidates; `probe` (optional) validates
 * unsaved credentials against the chosen host.
 */
interface NotifierAdapterBase {
  readonly descriptor: TargetKind
  /**
   * Optional live descriptor for the kind picker / editor. Used when the
   * static {@link descriptor} cannot carry fresh options (e.g. email's
   * smtp-provider entry select). Absent → {@link descriptor} is used as-is.
   */
  hydrateDescriptor?(): Promise<TargetKind>
  /**
   * The config keys that decide WHERE this kind's secrets are sent — the
   * server / base URL, the host-deriving instance id, the chat / bucket /
   * recipient. A NON-EMPTY tuple, so every adapter must name at least one:
   * an empty list would let a redacted secret be restored to anywhere.
   *
   * `mergeSecrets` restores a stored secret the editor left redacted ONLY while
   * every one of these is unchanged: a redacted token whose `serverUrl` was
   * edited would otherwise be delivered, by the next `testTarget`, to a host
   * the person who typed it never chose. A destination that is itself a
   * `password` field (the webhook `url`, the Discord webhook URL, the Pushover
   * recipient key) counts as unchanged while redacted.
   *
   * "Unchanged" is judged on the value the adapter would USE — an absent value
   * is the schema default, a field hidden for the stored config routes
   * nothing — see `destinations.ts`.
   */
  readonly destinationKeys: DestinationKeys
  /**
   * Canonical form of one destination value, for adapters that accept more
   * than one spelling of the same destination (zentik `userIds`: a CSV string
   * or a list). Absent → the value is compared as stored.
   */
  normalizeDestination?(key: string, value: unknown): unknown
  parseResult?(res: HttpResponseLike, bodyText: string): SendResult
  discover?(config: TargetConfig): Promise<readonly DiscoveredTarget[]>
  /**
   * Pre-save credential check against a partial (unsaved) config. Absent →
   * the cap returns a structured "not supported" result for that kind.
   */
  probe?(config: TargetConfig): Promise<ProbeResult>
}

/** HTTP notifier — pure `buildRequest` plan executed by the provider. */
export type HttpNotifierAdapter = NotifierAdapterBase & {
  readonly buildRequest: (config: TargetConfig, prepared: PreparedNotification) => HttpRequestPlan
  readonly sendDirect?: undefined
}

/** Cap-backed notifier (e.g. email via `smtp-provider`) — no HTTP plan. */
export type DirectNotifierAdapter = NotifierAdapterBase & {
  readonly sendDirect: (config: TargetConfig, prepared: PreparedNotification) => Promise<SendResult>
  readonly buildRequest?: undefined
}

export type NotifierAdapter = HttpNotifierAdapter | DirectNotifierAdapter
