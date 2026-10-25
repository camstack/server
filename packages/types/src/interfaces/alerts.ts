import type { Alert } from '../capabilities/alerts.cap.js'
import type { KnownEventCategory } from './event-bus.js'

/**
 * Provider interface for the `alerts` collection capability.
 *
 * Each provider declares which EventBus categories it subscribes to.
 * The built-in Alert Center addon persists alerts and serves them to the UI.
 */
export interface IAlertProvider {
  getSubscribedCategories(): readonly (KnownEventCategory | string)[]
  emit(alert: Alert): Promise<void>
  update(alertId: string, patch: Partial<Alert>): Promise<void>
}
