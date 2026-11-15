import {
  SessionHealthTracker,
  type IScopedLogger,
  type SessionHealthAlertsPort,
} from '@camstack/types'

export interface HomeComSessionAlertDeps {
  readonly logger: IScopedLogger
  /** Read lazily: `ctx.api.alerts` may be absent early in boot. */
  readonly getAlerts: () => SessionHealthAlertsPort | undefined
  readonly nameOf: (integrationId: string) => string
  /** Tests pass 0; the cloud refusing the sign-in is definitive, so production does too. */
  readonly debounceMs?: number
}

export interface HomeComSessionAlert {
  /** The cloud refused the stored sign-in: one alert per integration, with a way back in. */
  readonly authFailed: (integrationId: string) => void
  /** The integration connected: clear its alert. */
  readonly connected: (integrationId: string) => Promise<void>
  readonly removed: (integrationId: string) => Promise<void>
  readonly dispose: () => void
}

/** The standard session-lost alert for HomeCom; "Sign in again" opens the integration page. */
export function createHomeComSessionAlert(deps: HomeComSessionAlertDeps): HomeComSessionAlert {
  const tracker = new SessionHealthTracker({
    kind: 'homecom',
    providerName: 'Bosch HomeCom',
    logger: deps.logger,
    getAlerts: deps.getAlerts,
    debounceMs: deps.debounceMs ?? 0,
  })
  return {
    authFailed: (integrationId) =>
      tracker.lost(integrationId, {
        integrationName: deps.nameOf(integrationId),
        reason: 'token-expired',
        action: {
          label: 'Sign in again',
          href: `/integrations/${encodeURIComponent(integrationId)}`,
          navigation: 'app',
        },
      }),
    connected: (integrationId) => tracker.restored(integrationId),
    removed: (integrationId) => tracker.forget(integrationId),
    dispose: () => tracker.dispose(),
  }
}
