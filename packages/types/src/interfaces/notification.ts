import type { z } from 'zod'
import type { ConfigUISchema } from './config-ui.js'
import type { NotificationSchema } from '../capabilities/notification-output.cap.js'

/**
 * The canonical notification — single source of truth is the
 * `notification-output` cap's `NotificationSchema`. Callers emit this shape;
 * providers degrade it per their `TargetKind.caps`.
 */
export type Notification = z.infer<typeof NotificationSchema>

/**
 * Consumer-side envelope. `category` + `timestamp` are routing / rate-limit
 * concerns owned by `NotificationService`, NOT wire concerns — the cap `send`
 * payload stays the canonical `Notification`. The service strips these before
 * dispatching to a target.
 */
export type RoutedNotification = Notification & {
  readonly category: string
  readonly timestamp: number
}

/**
 * A toast notification for the admin UI.
 */
export interface Toast {
  readonly title: string
  readonly message: string
  readonly severity: 'info' | 'warning' | 'critical'
  readonly duration?: number
  readonly action?: {
    readonly label: string
    readonly url: string
  }
}

/**
 * Service interface for broadcasting toast notifications to connected clients.
 */
export interface IToastService {
  broadcast(toast: Toast): void
  sendToUser(userId: string, toast: Toast): void
}

/**
 * Legacy single-channel output view.
 *
 * @deprecated The canonical surface is the `notification-output` cap's
 * collection provider (`INotificationOutputProvider`, one per addon, keyed by
 * `addonId` and addressing individual targets via `send({ targetId, ... })`).
 * This interface survives only for `advanced-notifier`'s internal console
 * output; new providers implement the cap.
 */
export interface INotificationOutput {
  readonly id: string
  readonly name: string
  readonly icon: string

  /** Send a canonical notification through this single channel. */
  send(notification: Notification): Promise<void>

  /** Test the notification channel. */
  sendTest?(): Promise<{ success: boolean; error?: string }>

  /** Config schema for the admin UI. */
  getConfigSchema?(): ConfigUISchema
}
