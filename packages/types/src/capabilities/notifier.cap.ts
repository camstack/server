import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Notification delivery cap. Models HA `notify.<service>` plus future
 * native targets (Telegram / Discord / ntfy / SMTP, …). Designed at
 * the same structural level as a camera cap: rich multi-method
 * surface, full status diagnostics, explicit `supports` matrix so
 * the UI gates compose-form fields without probing the provider.
 *
 * One Notifier device per delivery endpoint — HA's `notify.mobile_app_*`
 * (one per phone), `notify.telegram_*` (one per chat target), etc.
 * The DeviceRole sub-role (MobilePushNotifier / MessagingNotifier /
 * EmailNotifier / GenericNotifier) discriminates the rendering style
 * of the compose form.
 *
 * Sub-feature support (image / priority / data / actions / multi-
 * recipient) is signaled by:
 *  - the device's `DeviceFeature` bits — fast scalar check for list
 *    filters and grid icons (DeviceFeature.NotifierImage etc.); AND
 *  - the slice's `supports` block — authoritative read after device
 *    detail is opened.
 */

const NotifierPrioritySchema = z.enum(['min', 'low', 'normal', 'high'])
export type NotifierPriority = z.infer<typeof NotifierPrioritySchema>

const NotifierActionSchema = z.object({
  /** Stable id used in the callback when the user taps the button. */
  id: z.string().min(1),
  /** User-visible button label. */
  title: z.string().min(1),
  /** Optional deep-link URI invoked on tap (rich notifiers only). */
  uri: z.url().optional(),
  /** Optional flag — when true, the action is destructive and the
   *  client should render the button in a warning style. */
  destructive: z.boolean().optional(),
})
export type NotifierAction = z.infer<typeof NotifierActionSchema>

const NotifierSupportsSchema = z.object({
  /** Inline / URL image attachment. Pair with `DeviceFeature.NotifierImage`. */
  image: z.boolean(),
  /** Priority hint. Pair with `DeviceFeature.NotifierPriority`. */
  priority: z.boolean(),
  /** Free-form platform-specific data block.
   *  Pair with `DeviceFeature.NotifierData`. */
  data: z.boolean(),
  /** Interactive action buttons. Pair with `DeviceFeature.NotifierActions`. */
  actions: z.boolean(),
  /** Per-call recipient targeting (multi-user notifiers).
   *  Pair with `DeviceFeature.NotifierRecipients`. */
  recipients: z.boolean(),
})
export type NotifierSupports = z.infer<typeof NotifierSupportsSchema>

export const NotifierStatusSchema = z.object({
  /** Ms epoch of the most recent successful send. 0 if none yet. */
  lastSentAt: z.number(),
  /** Failure description from the most recent send attempt. Null on
   *  success or when nothing has been sent yet. */
  lastError: z.string().nullable(),
  /** Number of deliveries currently buffered server-side (rate-limited
   *  notifiers may queue). 0 when the provider sends synchronously. */
  queueDepth: z.number().int().nonnegative().meta(readingMeta('count')),
  /** Per-feature capability matrix — authoritative source for the
   *  compose-form field gating. */
  supports: NotifierSupportsSchema,
})

export type NotifierStatus = z.infer<typeof NotifierStatusSchema>

const NotifierSendInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** Optional title — many platforms render it bolder than the body. */
  title: z.string().optional(),
  /** Required message body. */
  body: z.string().min(1),
  /** Optional image URL or inline data URI (`data:image/...;base64,...`). */
  image: z.string().optional(),
  /** Priority hint — providers without priority support ignore the field. */
  priority: NotifierPrioritySchema.optional(),
  /** Channel / topic / tag the notifier should route through (Android
   *  notification channel, Telegram chat id, ntfy topic, …). */
  channel: z.string().optional(),
  /** Optional list of recipient ids (multi-user notifiers). Empty /
   *  omitted = the device's default recipient. */
  recipients: z.array(z.string()).optional(),
  /** Optional interactive action buttons. */
  actions: z.array(NotifierActionSchema).optional(),
  /** Free-form platform-specific payload — passed through to the
   *  upstream service untouched. */
  data: z.record(z.string(), z.unknown()).optional(),
})

const NotifierSendResultSchema = z.object({
  /** Provider-assigned id for the delivery. Used for `cancel`. */
  notificationId: z.string(),
  /** Ms epoch when the notifier accepted the send (not when delivered). */
  acceptedAt: z.number(),
})

export type NotifierSendInput = z.infer<typeof NotifierSendInputSchema>
export type NotifierSendResult = z.infer<typeof NotifierSendResultSchema>

export const notifierCapability = {
  name: 'notifier',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Notifier],
  methods: {
    send: method(NotifierSendInputSchema, NotifierSendResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    cancel: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        notificationId: z.string().min(1),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  events: {
    /**
     * Emitted after every send attempt — success or failure. Subscribers
     * (admin UI history pane, automation engines, retry workers) react
     * without polling the provider's `lastSentAt`.
     */
    onSent: {
      data: z.object({
        deviceId: z.number(),
        notificationId: z.string(),
        success: z.boolean(),
        error: z.string().nullable(),
        acceptedAt: z.number(),
      }),
    },
  },
  status: {
    schema: NotifierStatusSchema,
    kind: 'command-driven',
  },
  /**
   * Runtime-state slice — diagnostics + supports matrix. UI compose
   * form reads `supports` to gate optional fields; history pane reads
   * `lastSentAt` / `lastError` / `queueDepth`.
   */
  runtimeState: NotifierStatusSchema,

  /**
   * Runtime-state durability: **session** — live queue depth and last-send state; a restored queue depth describes a queue that no longer exists.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — `queueDepth` is outbox operational state, not a device trend.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type INotifierProvider = InferProvider<typeof notifierCapability>
