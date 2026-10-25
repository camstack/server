import { randomUUID } from 'node:crypto'
import {
  notifierCapability,
  type DeviceContext,
  type InferNativeProvider,
  type NotifierStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: NotifierStatus = {
  lastSentAt: 0,
  lastError: null,
  queueDepth: 0,
  supports: {
    image: true,
    priority: true,
    data: true,
    actions: true,
    recipients: false,
  },
}

/**
 * HA-backed notifier device — corresponds to a HA `notify.<service>`
 * service. NOT a regular HA entity: HA's notify domain is service-
 * only, but the addon synthesises an entity-like presence in the
 * discovery cache so the operator can adopt it as a CamStack device.
 *
 * The HA service shape is:
 *   notify.<service>({title?, message, data?, target?})
 *
 * We map our cap's `send` input → that envelope. `target` becomes a
 * single-item or comma-separated list when `recipients` is provided
 * (HA's contract: target is service-specific — Telegram uses chat
 * ids, mobile_app uses user names, …; we forward as-is).
 *
 * Push state: HA doesn't surface notify history per service, so
 * `handleStatePush` is largely a no-op — the slice's `lastSentAt` /
 * `lastError` / `queueDepth` are driven by the `send` cap method
 * itself (post-call mutation).
 */
export class HaNotifierDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerNotifierCap()
    this.runtimeState.setCapState('notifier', COLD_START)
  }

  protected override handleStatePush(_state: HaEntityState): void {
    // HA notify services don't push state — operator-driven sends
    // are the only mutations of the slice.
  }

  private registerNotifierCap(): void {
    const serviceName = this.entityId.split('.')[1] ?? ''
    const provider: InferNativeProvider<typeof notifierCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<NotifierStatus>('notifier') ?? COLD_START
      },
      send: async ({ title, body, image, priority, channel, recipients, actions, data }) => {
        const serviceData: Record<string, unknown> = { message: body }
        if (title !== undefined) serviceData['title'] = title

        // HA notify `data` envelope — image, channel, priority, actions
        // are platform-specific extras. Mobile push expects them under
        // `data`; legacy SMTP / generic notifiers tolerate them too.
        const haData: Record<string, unknown> = { ...data }
        if (image !== undefined) haData['image'] = image
        if (priority !== undefined) haData['priority'] = priority
        if (channel !== undefined) haData['channel'] = channel
        if (actions !== undefined && actions.length > 0) {
          haData['actions'] = actions.map((a) => ({
            action: a.id,
            title: a.title,
            ...(a.uri !== undefined ? { uri: a.uri } : {}),
            ...(a.destructive ? { destructive: true } : {}),
          }))
        }
        if (Object.keys(haData).length > 0) serviceData['data'] = haData
        if (recipients !== undefined && recipients.length > 0) {
          serviceData['target'] = recipients.length === 1 ? recipients[0]! : recipients
        }

        const notificationId = randomUUID()
        const acceptedAt = Date.now()
        try {
          await this.callHaService('notify', serviceName, serviceData)
          this.runtimeState.setCapState('notifier', {
            ...COLD_START,
            ...(this.runtimeState.getCapState<NotifierStatus>('notifier') ?? COLD_START),
            lastSentAt: acceptedAt,
            lastError: null,
          })
          return { notificationId, acceptedAt }
        } catch (err) {
          const errMsgValue = err instanceof Error ? err.message : String(err)
          this.runtimeState.setCapState('notifier', {
            ...(this.runtimeState.getCapState<NotifierStatus>('notifier') ?? COLD_START),
            lastError: errMsgValue,
          })
          throw err
        }
      },
      cancel: async () => {
        // HA notify domain doesn't expose a cancel surface — once the
        // service call lands, dispatch is fire-and-forget. No-op for
        // compliance with the cap contract.
      },
    }
    this.ctx.registerNativeCap(notifierCapability, provider)
  }
}
