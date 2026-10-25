/**
 * The `notification-output` collection provider for the notifiers addon.
 *
 * It multiplexes across registered `NotifierAdapter`s:
 *   - `listTargetKinds` — every adapter's descriptor, `addonId`-stamped.
 *   - `listTargets`      — persisted targets, secrets redacted.
 *   - `discoverTargets`  — `adapter.discover?.() ?? []`.
 *   - `send` / `testTarget` — resolve target → `prepareNotification` (pure
 *      degrade engine) → fetch any `needsFetch` attachments (hard byte cap) →
 *      `adapter.buildRequest` → execute → map to `SendResult` with the engine's
 *      `renderedAs`. NEVER throws through the cap: every failure lands in
 *      `SendResult.error`.
 *   - CRUD — `TargetStore`, with server-side secret-merge on upsert.
 *
 * Registered with an EMPTY adapter list for now (adapters are plan tasks
 * T6–T12); the catalog is empty but every code path compiles + is tested.
 */
import {
  type DiscoveredTarget,
  type INotificationOutputProvider,
  type IScopedLogger,
  type Notification,
  type PreparedAttachment,
  type PreparedNotification,
  prepareNotification,
  type ProbeTargetConfigResult,
  type SendResult,
  type Target,
  type TargetKind,
} from '@camstack/types'
import type { HttpRequestPlan, HttpResponseLike, NotifierAdapter } from './adapters/adapter.js'
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type FetchedAttachment,
  fetchAttachmentBytes,
  sendHttpPlan,
} from './http.js'
import {
  mergeSecrets,
  passwordFieldKeys,
  redactForRead,
  REDACTED_MARKER,
  SecretRestoreRefusedError,
} from './secrets.js'
import type { TargetStore } from './target-store.js'

/** The addonId this provider stamps onto every kind + target for routing. */
export const NOTIFIERS_ADDON_ID = 'notifiers'

/** Hard cap on the response text retained for `parseResult` (provider errors are tiny). */
const MAX_RESPONSE_BODY_CHARS = 64 * 1024

/** Executes a pure request plan. Injectable so unit tests avoid the network. */
export type HttpSender = (plan: HttpRequestPlan) => Promise<HttpResponseLike>

/** Fetches a remote attachment into bytes under a hard cap. Injectable for tests. */
export type AttachmentFetcher = (url: string, maxBytes: number) => Promise<FetchedAttachment>

export interface NotificationOutputProviderDeps {
  readonly store: TargetStore
  readonly adapters: readonly NotifierAdapter[]
  readonly addonId?: string
  readonly httpSend?: HttpSender
  readonly fetchAttachment?: AttachmentFetcher
  readonly logger?: IScopedLogger
  /**
   * Resolves a kind's bundled brand-icon URL (served by the addon over its
   * `addon-routes` HTTP surface). When it returns a URL, `listTargetKinds`
   * stamps `iconUrl` onto that kind's descriptor so the admin UI can render an
   * `<img>` instead of a text label. Absent → no `iconUrl` is stamped.
   */
  readonly iconUrlFor?: (kind: string) => string | undefined
  /**
   * Resolves a kind's icon MEDIA TYPE, stamped alongside `iconUrl` so a client
   * knows which renderer to use (React Native needs different components for
   * SVG and raster). Absent → no `iconMediaType` is stamped.
   */
  readonly iconMediaTypeFor?: (kind: string) => string | undefined
}

/** Placeholder a URL is replaced with in any error the provider returns or logs. */
const URL_PLACEHOLDER = '<url>'

/** An absolute URL: a scheme, `://`, then everything up to whitespace or a quote. */
const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi

/**
 * Node's `fetch` reports an unparseable url as `Failed to parse URL from <x>`
 * — and a malformed value is exactly the one with no scheme for
 * {@link ABSOLUTE_URL} to find, so the rest of that LINE is cut whole — a
 * malformed value may contain spaces, and a `\S+` cut leaked what followed.
 */
const UNPARSEABLE_URL_TAIL = /(Failed to parse URL from )[^\n]*/gi

/**
 * Remove every URL from an error message.
 *
 * A notifier URL is routinely a credential — the Telegram bot token is in the
 * path, a Discord webhook URL is the whole secret, a webhook often carries a
 * `?token=` — and a transport error names the url it dialled. The message
 * keeps its cause (`ECONNRESET`, `HTTP 401`) and loses the address.
 */
export function stripUrls(message: string): string {
  return message
    .replace(UNPARSEABLE_URL_TAIL, `$1${URL_PLACEHOLDER}`)
    .replace(ABSOLUTE_URL, URL_PLACEHOLDER)
}

/** An error's message, with every URL removed — the only form returned or logged. */
function errMsg(err: unknown): string {
  return stripUrls(err instanceof Error ? err.message : String(err))
}

/** The canned notification `testTarget` sends when the caller omits a sample. */
function cannedNotification(): Notification {
  return {
    body: 'This is a CamStack test notification.',
    title: 'CamStack',
    format: 'text',
    priority: 3,
  }
}

/**
 * Build the concrete `notification-output` provider. Returns a plain object
 * matching `INotificationOutputProvider` so the addon can register it with the
 * cap router as a collection entry.
 */
export function createNotificationOutputProvider(
  deps: NotificationOutputProviderDeps,
): INotificationOutputProvider {
  const addonId = deps.addonId ?? NOTIFIERS_ADDON_ID
  const httpSend: HttpSender = deps.httpSend ?? ((plan) => sendHttpPlan(plan))
  const fetchAttachment: AttachmentFetcher =
    deps.fetchAttachment ?? ((url, maxBytes) => fetchAttachmentBytes(url, maxBytes))
  const store = deps.store
  const logger = deps.logger

  const adapterByKind = new Map<string, NotifierAdapter>()
  for (const adapter of deps.adapters) {
    adapterByKind.set(adapter.descriptor.kind, adapter)
  }

  /**
   * Blank / redacted password fields never carry the live token from the UI.
   * Drop them so `mergeSecrets` can restore from a stored target (edit or clone).
   */
  function omitBlankSecrets(
    config: Record<string, unknown>,
    adapter: NotifierAdapter,
  ): Record<string, unknown> {
    const keys = passwordFieldKeys(adapter.descriptor)
    if (keys.size === 0) return config
    const out: Record<string, unknown> = { ...config }
    for (const key of keys) {
      const value = out[key]
      if (value === '' || value === REDACTED_MARKER || value === undefined) {
        delete out[key]
      }
    }
    return out
  }

  /**
   * Config the wire should dial: form values with stored secrets restored when
   * `targetId` names a row (edit / duplicate probe & discover).
   */
  async function configWithStoredSecrets(
    kind: string,
    config: Record<string, unknown>,
    targetId: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (targetId === undefined) return config
    const adapter = adapterByKind.get(kind)
    if (!adapter) return config
    const existing = await store.getById(targetId)
    if (existing === null) return config
    return mergeSecrets({
      existing,
      incoming: { id: targetId, kind, config: omitBlankSecrets(config, adapter) },
      adapter,
    })
  }

  async function resolveAttachments(
    prepared: PreparedNotification,
    maxBytes: number | undefined,
  ): Promise<readonly PreparedAttachment[]> {
    if (prepared.attachments.length === 0) return prepared.attachments
    const cap = maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
    const out: PreparedAttachment[] = []
    for (const att of prepared.attachments) {
      if (att.needsFetch && att.bytes === undefined && att.url !== undefined) {
        const fetched = await fetchAttachment(att.url, cap)
        out.push({
          mediaType: att.mediaType,
          bytes: fetched.bytes,
          needsFetch: false,
          ...(att.url !== undefined ? { url: att.url } : {}),
          ...((att.mime ?? fetched.mime) ? { mime: att.mime ?? fetched.mime } : {}),
          ...((att.name ?? fetched.name) ? { name: att.name ?? fetched.name } : {}),
        })
      } else {
        out.push(att)
      }
    }
    return out
  }

  /** The full degrade → build → send pipeline for one target. Never throws. */
  async function dispatch(target: Target, notification: Notification): Promise<SendResult> {
    const adapter = adapterByKind.get(target.kind)
    if (!adapter) {
      return { success: false, error: `No adapter registered for kind '${target.kind}'` }
    }

    // Green API accepts sendMessage with HTTP 200 + idMessage even while
    // `stateInstance: notAuthorized` — the message never delivers. When an
    // adapter exposes `probe`, refuse the send rather than report a false success.
    if (adapter.probe) {
      try {
        const probe = await adapter.probe(target.config)
        if (!probe.ok) {
          return {
            success: false,
            error: probe.error ?? 'credential probe failed before send',
          }
        }
      } catch (err) {
        return {
          success: false,
          error: `credential probe failed: ${errMsg(err)}`,
        }
      }
    }

    const caps = adapter.descriptor.caps
    const prepared = prepareNotification(caps, notification)

    let attachments: readonly PreparedAttachment[]
    try {
      attachments = await resolveAttachments(prepared, caps.attachments.maxBytes)
    } catch (err) {
      return {
        success: false,
        error: `attachment fetch failed: ${errMsg(err)}`,
        renderedAs: prepared.renderedAs,
      }
    }
    const readyPrepared: PreparedNotification =
      attachments === prepared.attachments ? prepared : { ...prepared, attachments }

    if (adapter.sendDirect) {
      try {
        const result = await adapter.sendDirect(target.config, readyPrepared)
        return result.error === undefined
          ? { ...result, renderedAs: prepared.renderedAs }
          : { ...result, error: stripUrls(result.error), renderedAs: prepared.renderedAs }
      } catch (err) {
        logger?.warn('sendDirect failed', { meta: { kind: target.kind, error: errMsg(err) } })
        return {
          success: false,
          error: `sendDirect failed: ${errMsg(err)}`,
          renderedAs: prepared.renderedAs,
        }
      }
    }

    if (!adapter.buildRequest) {
      return {
        success: false,
        error: `No adapter send path for kind '${target.kind}'`,
        renderedAs: prepared.renderedAs,
      }
    }

    let plan: HttpRequestPlan
    try {
      plan = adapter.buildRequest(target.config, readyPrepared)
    } catch (err) {
      logger?.warn('buildRequest failed', { meta: { kind: target.kind, error: errMsg(err) } })
      return {
        success: false,
        error: `buildRequest failed: ${errMsg(err)}`,
        renderedAs: prepared.renderedAs,
      }
    }

    let res: HttpResponseLike
    try {
      res = await httpSend(plan)
    } catch (err) {
      logger?.warn('request failed', { meta: { kind: target.kind, error: errMsg(err) } })
      return {
        success: false,
        error: `request failed: ${errMsg(err)}`,
        renderedAs: prepared.renderedAs,
      }
    }

    // Read the body ONCE so a `parseResult` can inspect the provider's error
    // JSON (`res.text()` is async — an adapter can't call it from a sync hook).
    // Capped so a hostile/huge response can't blow up memory.
    let bodyText = ''
    try {
      const raw = await res.text()
      bodyText = raw.length > MAX_RESPONSE_BODY_CHARS ? raw.slice(0, MAX_RESPONSE_BODY_CHARS) : raw
    } catch {
      bodyText = ''
    }

    let result: SendResult
    if (adapter.parseResult) {
      try {
        result = adapter.parseResult(res, bodyText)
      } catch (err) {
        result = { success: false, error: `parseResult failed: ${errMsg(err)}` }
      }
    } else {
      result = res.ok
        ? { success: true }
        : { success: false, error: `HTTP ${res.status} ${res.statusText}` }
    }
    // An adapter's own error text quotes the provider's response body, which
    // can echo the request url back — it is cut like every other error.
    return result.error === undefined
      ? { ...result, renderedAs: prepared.renderedAs }
      : { ...result, error: stripUrls(result.error), renderedAs: prepared.renderedAs }
  }

  const iconUrlFor = deps.iconUrlFor
  const iconMediaTypeFor = deps.iconMediaTypeFor

  return {
    listTargetKinds: async (): Promise<TargetKind[]> => {
      const kinds: TargetKind[] = []
      for (const a of deps.adapters) {
        // Live descriptors (email's smtp-provider select) win over the static
        // catalog when the adapter hydrates options from the cluster.
        const base = a.hydrateDescriptor !== undefined ? await a.hydrateDescriptor() : a.descriptor
        // `destinationKeys` is published so an editor can tell WHICH edit will
        // need the secret re-typed, instead of warning on every edit (D634).
        const descriptor: TargetKind = {
          ...base,
          addonId,
          destinationKeys: [...a.destinationKeys],
        }
        // `iconUrl` is DECLARED on `TargetKindSchema`, so it survives any
        // validation on the way out. Omitted (not null) when the addon bundles
        // no icon for the kind — the client falls back to a neutral glyph.
        const iconUrl = iconUrlFor?.(base.kind)
        if (iconUrl === undefined) {
          kinds.push(descriptor)
          continue
        }
        const iconMediaType = iconMediaTypeFor?.(base.kind)
        kinds.push(
          iconMediaType !== undefined
            ? { ...descriptor, iconUrl, iconMediaType }
            : { ...descriptor, iconUrl },
        )
      }
      return kinds
    },

    listTargets: async (): Promise<Target[]> => {
      const targets = await store.list()
      return targets.map((target) => {
        const adapter = adapterByKind.get(target.kind)
        const redacted = adapter ? redactForRead(target, adapter.descriptor) : target
        return { ...redacted, addonId }
      })
    },

    getTarget: async ({ targetId }): Promise<Target> => {
      const target = await store.getById(targetId)
      if (target === null) {
        throw new Error(`Unknown target '${targetId}'`)
      }
      // Unredacted — admin edit/duplicate only. listTargets stays masked.
      return { ...target, addonId }
    },

    discoverTargets: async ({ kind, config, targetId }): Promise<DiscoveredTarget[]> => {
      const adapter = adapterByKind.get(kind)
      if (!adapter?.discover) return []
      try {
        const effective = await configWithStoredSecrets(kind, config ?? {}, targetId)
        return [...(await adapter.discover(effective))]
      } catch (err) {
        // Surface the failure to the UI (e.g. WhatsApp notAuthorized) —
        // swallowing as [] made "scan the QR first" look like an empty book.
        logger?.warn('discover failed', { meta: { kind, error: errMsg(err) } })
        throw err instanceof Error ? err : new Error(errMsg(err))
      }
    },

    probeTargetConfig: async ({ kind, config, targetId }): Promise<ProbeTargetConfigResult> => {
      const adapter = adapterByKind.get(kind)
      if (!adapter?.probe) {
        return {
          ok: false,
          resolvedUrl: '',
          error: `Kind '${kind}' does not support credential probing`,
        }
      }
      try {
        const effective = await configWithStoredSecrets(kind, config, targetId)
        const result = await adapter.probe(effective)
        return {
          ok: result.ok,
          resolvedUrl: result.resolvedUrl,
          ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          ...(result.stateInstance !== undefined ? { stateInstance: result.stateInstance } : {}),
          ...(result.error !== undefined ? { error: stripUrls(result.error) } : {}),
        }
      } catch (err) {
        if (err instanceof SecretRestoreRefusedError) {
          return { ok: false, resolvedUrl: '', error: stripUrls(err.message) }
        }
        logger?.warn('probe failed', { meta: { kind, error: errMsg(err) } })
        return { ok: false, resolvedUrl: '', error: stripUrls(errMsg(err)) }
      }
    },

    send: async ({ targetId, notification }): Promise<SendResult> => {
      const target = await store.getById(targetId)
      if (!target) return { success: false, error: `Unknown target '${targetId}'` }
      if (!target.enabled) return { success: false, error: 'Target is disabled' }
      return dispatch(target, notification)
    },

    testTarget: async ({ targetId, sample }): Promise<SendResult> => {
      const target = await store.getById(targetId)
      if (!target) return { success: false, error: `Unknown target '${targetId}'` }
      return dispatch(target, sample ?? cannedNotification())
    },

    upsertTarget: async ({ target, cloneSecretsFrom }): Promise<Target> => {
      const adapter = adapterByKind.get(target.kind)
      // `getById` returns `null` when missing — never compare to `undefined`.
      const existingById = await store.getById(target.id)
      const cloneSource =
        existingById === null && cloneSecretsFrom !== undefined
          ? await store.getById(cloneSecretsFrom)
          : null
      const existing = existingById ?? cloneSource
      // Throws `SecretRestoreRefusedError` when a redacted secret would follow
      // a changed kind or destination — the save is refused, nothing is stored.
      const incoming = adapter
        ? { ...target, config: omitBlankSecrets(target.config, adapter) }
        : target
      const config = adapter
        ? mergeSecrets({
            existing: existing ?? undefined,
            incoming,
            adapter,
          })
        : { ...target.config }
      const toStore: Target = { ...target, addonId, config }
      await store.upsert(toStore)
      const redacted = adapter ? redactForRead(toStore, adapter.descriptor) : toStore
      return { ...redacted, addonId }
    },

    deleteTarget: async ({ targetId }): Promise<void> => {
      await store.delete(targetId)
    },

    setTargetEnabled: async ({ targetId, enabled }): Promise<void> => {
      await store.setEnabled(targetId, enabled)
    },
  }
}
