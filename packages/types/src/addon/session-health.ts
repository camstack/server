/**
 * Session health — the STANDARD "cloud connection lost" alert (D-session-health).
 *
 * Every addon that keeps a cloud session for an integration (an account login, a
 * refresh token, a long-lived socket) reports two facts and nothing else:
 *
 *   - `lost(integrationId, …)`  the session was refused / kicked / dropped;
 *   - `restored(integrationId)` a call went through again.
 *
 * The tracker owns everything between: a debounce (a transient reconnect never
 * alerts), ONE alert per integration instance (never one per device, never one
 * per failed poll), the wording (provider, integration, reason), an action the
 * operator can follow, and the automatic resolve when the session is back.
 *
 * Alerts are durable state that the next run of the addon cannot see, so the
 * first `restored()` of a process resolves whatever a previous run left active.
 */

import type { Alert, AlertSeverity } from '../capabilities/alerts.cap.js'
import type { IScopedLogger } from '../interfaces/logging.js'

/** Why the session ended. `kicked` = the same account signed in elsewhere. */
export type SessionLossReason = 'kicked' | 'auth-rejected' | 'token-expired' | 'connection-lost'

/** What an alert's action looks like (the `Alert.action` shape). */
export interface SessionAlertAction {
  readonly label: string
  readonly href?: string
  readonly navigation?: 'app' | 'server'
}

/** The slice of `ctx.api.alerts` the tracker needs. Structural, so `ctx.api.alerts` fits. */
export interface SessionHealthAlertsPort {
  readonly emit?: { mutate(alert: Alert): Promise<unknown> }
  readonly update?: {
    mutate(input: { readonly alertId: string; readonly patch: Partial<Alert> }): Promise<unknown>
  }
}

export const SESSION_LOST_ALERT_CATEGORY = 'integration.session-lost'
const SESSION_EPISODE_KEY = 'session-lost'
/** A transient reconnect is quiet for this long before it is worth an alert. */
export const DEFAULT_SESSION_LOST_DEBOUNCE_MS = 2 * 60_000

const REASON_TEXT: Readonly<Record<SessionLossReason, string>> = {
  kicked: 'the account was signed in on another device, which ended this session',
  'auth-rejected': 'the cloud rejected the sign-in (check the credentials)',
  'token-expired': 'the session token expired and could not be renewed',
  'connection-lost': 'the connection to the cloud was lost',
}

export function sessionLostAlertId(kind: string, integrationId: string): string {
  return `session:${kind}:${integrationId}`
}

export interface BuildSessionLostAlertInput {
  /** Stable provider key, e.g. `petkit` — part of the alert id and source. */
  readonly kind: string
  /** Display name, e.g. `PetKit`. */
  readonly providerName: string
  readonly integrationId: string
  readonly integrationName: string
  readonly reason: SessionLossReason
  /** Defaults to "Open integration" (the admin integration page). */
  readonly action?: SessionAlertAction
  readonly severity?: AlertSeverity
  readonly now?: number
}

/** Pure builder, exported so an addon with its own flow can still emit the standard shape. */
export function buildSessionLostAlert(input: BuildSessionLostAlertInput): Alert {
  const now = input.now ?? Date.now()
  return {
    id: sessionLostAlertId(input.kind, input.integrationId),
    category: SESSION_LOST_ALERT_CATEGORY,
    severity: input.severity ?? 'error',
    title: `${input.providerName} connection lost`,
    message: `${input.integrationName} lost its ${input.providerName} session: ${REASON_TEXT[input.reason]}.`,
    action: input.action ?? {
      label: 'Open integration',
      href: `/integrations/${encodeURIComponent(input.integrationId)}`,
    },
    status: 'active',
    read: false,
    createdAt: now,
    updatedAt: now,
    source: { type: input.kind, id: input.integrationId },
    metadata: { episodeKey: SESSION_EPISODE_KEY, reason: input.reason },
  }
}

export interface SessionHealthTrackerOptions {
  readonly kind: string
  readonly providerName: string
  readonly logger: IScopedLogger
  /** Read lazily: `ctx.api.alerts` may be absent early in boot. */
  readonly getAlerts: () => SessionHealthAlertsPort | undefined
  readonly debounceMs?: number
}

export interface SessionLostInfo {
  readonly integrationName: string
  readonly reason: SessionLossReason
  /** Re-auth route when the addon has one; otherwise "Open integration". */
  readonly action?: SessionAlertAction
}

/**
 * - `pending`  loss reported, debounce running;
 * - `unsent`   debounce elapsed but the emit failed — the next `lost()` retries;
 * - `alerted`  the alert is active;
 * - `ok`       the session is healthy (a resolve, if any, was sent).
 */
type Phase = 'pending' | 'unsent' | 'alerted' | 'ok'

interface Entry {
  phase: Phase
  info: SessionLostInfo
  timer: ReturnType<typeof setTimeout> | null
}

export class SessionHealthTracker {
  readonly #opts: SessionHealthTrackerOptions
  readonly #debounceMs: number
  readonly #entries = new Map<string, Entry>()

  constructor(opts: SessionHealthTrackerOptions) {
    this.#opts = opts
    this.#debounceMs = opts.debounceMs ?? DEFAULT_SESSION_LOST_DEBOUNCE_MS
  }

  /** The session is gone. Idempotent: call it on every failed poll. */
  lost(integrationId: string, info: SessionLostInfo): void {
    const tags = { integrationId }
    const entry = this.#entries.get(integrationId)
    if (entry === undefined || entry.phase === 'ok') {
      const timer = setTimeout(() => void this.#fire(integrationId), this.#debounceMs)
      this.#entries.set(integrationId, { phase: 'pending', info, timer })
      this.#opts.logger.info(
        `${this.#opts.providerName} session lost — alert after ${this.#debounceMs}ms unless it recovers`,
        { tags, meta: { reason: info.reason } },
      )
      return
    }
    entry.info = info
    if (entry.phase === 'pending') {
      this.#opts.logger.debug(`${this.#opts.providerName} session still lost — alert pending`, {
        tags,
        meta: { reason: info.reason },
      })
      return
    }
    if (entry.phase === 'unsent') {
      void this.#emit(integrationId, entry)
      return
    }
    this.#opts.logger.debug(
      `${this.#opts.providerName} session still lost — alert already active`,
      {
        tags,
        meta: { reason: info.reason },
      },
    )
  }

  /** A call went through. Idempotent: call it on every successful poll. */
  async restored(integrationId: string): Promise<void> {
    const tags = { integrationId }
    const entry = this.#entries.get(integrationId)
    if (entry === undefined) {
      this.#entries.set(integrationId, { phase: 'ok', info: EMPTY_INFO, timer: null })
      // A previous run may have left the alert active; resolving a missing one is a no-op.
      // Without the alerts capability yet (early boot) nothing was reconciled: forget
      // the entry so the next success tries again.
      const attempted = await this.#resolve(integrationId, 'startup reconcile')
      if (!attempted) this.#entries.delete(integrationId)
      return
    }
    if (entry.phase === 'ok') return
    this.#clearTimer(entry)
    const previous = entry.phase
    entry.phase = 'ok'
    if (previous === 'pending' || previous === 'unsent') {
      this.#opts.logger.info(
        `${this.#opts.providerName} session recovered inside the debounce — no alert`,
        { tags },
      )
      return
    }
    await this.#resolve(integrationId, 'session restored')
  }

  /** The integration is gone (deleted / disabled): drop its state and its alert. */
  async forget(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined) return
    this.#clearTimer(entry)
    this.#entries.delete(integrationId)
    if (entry.phase === 'alerted') await this.#resolve(integrationId, 'integration removed')
  }

  /** Stop every pending timer (addon shutdown). */
  dispose(): void {
    for (const entry of this.#entries.values()) this.#clearTimer(entry)
    this.#entries.clear()
  }

  #clearTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }

  async #fire(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined || entry.phase !== 'pending') return
    entry.timer = null
    await this.#emit(integrationId, entry)
  }

  async #emit(integrationId: string, entry: Entry): Promise<void> {
    const tags = { integrationId }
    const emit = this.#opts.getAlerts()?.emit
    if (emit === undefined) {
      entry.phase = 'unsent'
      this.#opts.logger.warn(
        `${this.#opts.providerName} session alert skipped — alerts capability missing`,
        { tags },
      )
      return
    }
    try {
      await emit.mutate(
        buildSessionLostAlert({
          kind: this.#opts.kind,
          providerName: this.#opts.providerName,
          integrationId,
          integrationName: entry.info.integrationName,
          reason: entry.info.reason,
          ...(entry.info.action !== undefined ? { action: entry.info.action } : {}),
        }),
      )
      entry.phase = 'alerted'
      this.#opts.logger.warn(`${this.#opts.providerName} session lost — alert raised`, {
        tags,
        meta: { reason: entry.info.reason },
      })
    } catch (err) {
      entry.phase = 'unsent'
      this.#opts.logger.warn(`${this.#opts.providerName} session alert emit failed`, {
        tags,
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  async #resolve(integrationId: string, why: string): Promise<boolean> {
    const tags = { integrationId }
    const update = this.#opts.getAlerts()?.update
    if (update === undefined) {
      this.#opts.logger.debug(
        `${this.#opts.providerName} session alert not resolved — no alerts cap`,
        {
          tags,
        },
      )
      return false
    }
    try {
      await update.mutate({
        alertId: sessionLostAlertId(this.#opts.kind, integrationId),
        patch: { status: 'completed', read: true },
      })
      this.#opts.logger.info(`${this.#opts.providerName} session alert resolved`, {
        tags,
        meta: { why },
      })
    } catch (err) {
      this.#opts.logger.debug(`${this.#opts.providerName} session alert resolve skipped`, {
        tags,
        meta: { why, error: err instanceof Error ? err.message : String(err) },
      })
    }
    return true
  }
}

const EMPTY_INFO: SessionLostInfo = { integrationName: '', reason: 'connection-lost' }

export interface IntegrationSessionBinding {
  readonly logger: IScopedLogger
  readonly getAlerts: () => SessionHealthAlertsPort | undefined
  readonly debounceMs?: number
}

export interface IntegrationSessionReporterOptions {
  readonly kind: string
  readonly providerName: string
  /**
   * Is `err` the cloud ending OUR session (kicked, token refused, sign-in
   * rejected)? `null` for anything else — a network blip or a per-device error
   * must never read as a lost session.
   */
  readonly classify: (err: unknown) => SessionLossReason | null
  /** Re-auth route when the addon has one; otherwise "Open integration". */
  readonly action?: (integrationId: string) => SessionAlertAction | undefined
}

/**
 * The addon-facing face of {@link SessionHealthTracker}: a process-wide object an
 * integration manager AND its device classes can reach (the kernel builds a
 * device from a `DeviceContext` alone, so neither can be handed a tracker).
 * The addon `bind()`s it in `onInitialize`, `unbind()`s it on shutdown and
 * `forget()`s an integration that vanished; everything before `bind` is a no-op.
 */
export class IntegrationSessionReporter {
  readonly #opts: IntegrationSessionReporterOptions
  #tracker: SessionHealthTracker | null = null
  readonly #names = new Map<string, string>()

  constructor(opts: IntegrationSessionReporterOptions) {
    this.#opts = opts
  }

  bind(binding: IntegrationSessionBinding): void {
    this.#tracker?.dispose()
    this.#tracker = new SessionHealthTracker({
      kind: this.#opts.kind,
      providerName: this.#opts.providerName,
      logger: binding.logger,
      getAlerts: binding.getAlerts,
      ...(binding.debounceMs !== undefined ? { debounceMs: binding.debounceMs } : {}),
    })
  }

  unbind(): void {
    this.#tracker?.dispose()
    this.#tracker = null
  }

  /** The manager tells us the display name once, so a device can report by id alone. */
  register(integrationId: string, integrationName: string): void {
    this.#names.set(integrationId, integrationName)
  }

  /** A call failed. Only a session-ending failure counts; anything else is ignored. */
  failure(integrationId: string, err: unknown): void {
    const reason = this.#opts.classify(err)
    if (reason === null) return
    const action = this.#opts.action?.(integrationId)
    this.#tracker?.lost(integrationId, {
      integrationName: this.#names.get(integrationId) ?? integrationId,
      reason,
      ...(action !== undefined ? { action } : {}),
    })
  }

  /** A call went through. */
  async ok(integrationId: string): Promise<void> {
    await this.#tracker?.restored(integrationId)
  }

  /** The integration was removed. */
  async forget(integrationId: string): Promise<void> {
    this.#names.delete(integrationId)
    await this.#tracker?.forget(integrationId)
  }
}

/** What a manager / device depends on to report. */
export type IntegrationSessionSink = Pick<IntegrationSessionReporter, 'register' | 'failure' | 'ok'>
