/**
 * RegistryReachabilityTracker — "the hub cannot reach npm / Hugging Face" as an
 * alert episode, not only a log line.
 *
 * It owns no clock and makes no request. It hears the outcomes of the calls the
 * hub already makes: the update sweep's addon lookups (npm, every few hours)
 * and the model downloads that happen on demand (Hugging Face).
 *
 * ## When an episode opens
 *
 * A single failed probe never raises: a registry blips. The alert opens on the
 * SECOND consecutive failure, and only when the first of them is at least
 * {@link REGISTRY_UNREACHABLE_MIN_FAILURE_MS} old. The sweep runs every 15 min
 * to 7 days (default 6 h), so "two failed sweeps" is already hours; the age
 * floor is what stops a burst — an operator pressing refresh, a download
 * retried three times in a second — from reading as an outage.
 *
 * ## When it closes
 *
 * On the first outcome that REACHED the registry. The alert is `critical`, so
 * the alert centre announces both edges (D890) and a Notification Center rule
 * on `alert-critical` / `alert-critical-resolved` tells the phone — this class
 * sends nothing itself.
 */
import type { Alert, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

export type RegistryId = 'npm' | 'huggingface'

/** Consecutive failed probes before an episode may open. */
export const REGISTRY_UNREACHABLE_MIN_FAILURES = 2
/** The first failure must be at least this old when the threshold is met. */
export const REGISTRY_UNREACHABLE_MIN_FAILURE_MS = 10 * 60_000

export const REGISTRY_UNREACHABLE_CATEGORY = 'registry.unreachable'
const EPISODE_KEY = 'registry-unreachable'

/** The slice of the `alerts` provider the tracker needs. */
export interface RegistryAlertsPort {
  emit(alert: Alert): Promise<unknown>
  update(input: { readonly alertId: string; readonly patch: Partial<Alert> }): Promise<unknown>
}

export function registryUnreachableAlertId(registry: RegistryId): string {
  return `registry-unreachable:${registry}`
}

interface RegistryWords {
  readonly name: string
  readonly impact: string
}

const WORDS: Readonly<Record<RegistryId, RegistryWords>> = {
  npm: {
    name: 'npm',
    impact: 'Addon and server updates are paused',
  },
  huggingface: {
    name: 'Hugging Face',
    impact: 'Model downloads are failing',
  },
}

export function buildRegistryUnreachableAlert(
  registry: RegistryId,
  reason: string,
  now: number,
): Alert {
  const words = WORDS[registry]
  return {
    id: registryUnreachableAlertId(registry),
    category: REGISTRY_UNREACHABLE_CATEGORY,
    severity: 'critical',
    title: `${words.name} cannot be reached`,
    message: `CamStack cannot reach ${words.name}. ${words.impact} until the connection is back (${reason}). Check the hub's internet access, DNS and proxy.`,
    status: 'active',
    read: false,
    createdAt: now,
    updatedAt: now,
    source: { type: 'registry', id: registry },
    metadata: { episodeKey: EPISODE_KEY, registry },
  }
}

interface RegistryState {
  failures: number
  firstFailureAt: number
  alerted: boolean
  /** Sent the startup reconcile (resolve a leftover episode from a previous run). */
  reconciled: boolean
}

export interface RegistryReachabilityTrackerOptions {
  readonly logger: IScopedLogger
  /** Read lazily: the alerts capability may be absent early in boot. */
  readonly getAlerts: () => RegistryAlertsPort | undefined
  readonly now?: () => number
}

export class RegistryReachabilityTracker {
  readonly #logger: IScopedLogger
  readonly #getAlerts: () => RegistryAlertsPort | undefined
  readonly #now: () => number
  readonly #state = new Map<RegistryId, RegistryState>()

  constructor(options: RegistryReachabilityTrackerOptions) {
    this.#logger = options.logger
    this.#getAlerts = options.getAlerts
    this.#now = options.now ?? Date.now
  }

  /** A probe could not reach the registry. Idempotent per call: it only counts. */
  async failed(registry: RegistryId, reason: string): Promise<void> {
    const now = this.#now()
    const state = this.#stateOf(registry)
    if (state.failures === 0) state.firstFailureAt = now
    state.failures += 1
    this.#logger.warn(`${WORDS[registry].name} unreachable`, {
      meta: { registry, consecutiveFailures: state.failures, reason },
    })
    if (state.alerted) return
    if (state.failures < REGISTRY_UNREACHABLE_MIN_FAILURES) return
    if (now - state.firstFailureAt < REGISTRY_UNREACHABLE_MIN_FAILURE_MS) return
    await this.#open(registry, state, reason, now)
  }

  /** A probe reached the registry (any answer below 5xx). Resolves an open episode. */
  async reached(registry: RegistryId): Promise<void> {
    const state = this.#stateOf(registry)
    const wasAlerted = state.alerted
    const firstSuccess = !state.reconciled
    state.failures = 0
    state.firstFailureAt = 0
    state.alerted = false
    state.reconciled = true
    // First success after boot also closes an episode a previous run left open
    // (resolving one that is not there is a no-op in the alert centre).
    if (!wasAlerted && !firstSuccess) return
    await this.#resolve(registry, wasAlerted ? 'registry reachable again' : 'startup reconcile')
  }

  #stateOf(registry: RegistryId): RegistryState {
    const existing = this.#state.get(registry)
    if (existing !== undefined) return existing
    const created: RegistryState = {
      failures: 0,
      firstFailureAt: 0,
      alerted: false,
      reconciled: false,
    }
    this.#state.set(registry, created)
    return created
  }

  async #open(
    registry: RegistryId,
    state: RegistryState,
    reason: string,
    now: number,
  ): Promise<void> {
    const alerts = this.#getAlerts()
    if (alerts === undefined) {
      this.#logger.warn('Registry unreachable alert skipped — alerts capability missing', {
        meta: { registry },
      })
      return
    }
    try {
      await alerts.emit(buildRegistryUnreachableAlert(registry, reason, now))
      state.alerted = true
      this.#logger.warn(`${WORDS[registry].name} unreachable — alert raised`, {
        meta: { registry, consecutiveFailures: state.failures },
      })
    } catch (error: unknown) {
      // Not alerted: the next failed probe tries again.
      this.#logger.warn('Registry unreachable alert emit failed', {
        meta: { registry, error: errMsg(error) },
      })
    }
  }

  async #resolve(registry: RegistryId, why: string): Promise<void> {
    const alerts = this.#getAlerts()
    if (alerts === undefined) {
      this.#logger.debug('Registry alert not resolved — alerts capability missing', {
        meta: { registry, why },
      })
      return
    }
    try {
      await alerts.update({
        alertId: registryUnreachableAlertId(registry),
        patch: { status: 'completed', read: true },
      })
      this.#logger.info(`${WORDS[registry].name} reachable — alert resolved`, {
        meta: { registry, why },
      })
    } catch (error: unknown) {
      this.#logger.debug('Registry alert resolve skipped', {
        meta: { registry, why, error: errMsg(error) },
      })
    }
  }
}
