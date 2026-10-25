import type {
  INotificationOutputProvider,
  RoutedNotification,
  ICapabilityRegistry,
} from '@camstack/types'
import type { IScopedLogger } from '../logging/scoped-logger.js'
import { errMsg } from '@camstack/types'

/**
 * A routing destination: one target (`targetId`) owned by one provider
 * (`addonId`). The notifiers addon and the HA addon each register a
 * `notification-output` collection provider; the service resolves the
 * provider by `addonId` and dispatches to the specific target.
 */
export interface NotificationTargetRef {
  readonly addonId: string
  readonly targetId: string
}

/**
 * Central notification service that routes canonical notifications to
 * configured `(addonId, targetId)` targets. Framework-agnostic —
 * dependencies injected via constructor.
 *
 * Providers are resolved from the ICapabilityRegistry by `addonId` on each
 * call (proxy pattern). Falls back to a local map when no registry is
 * provided (tests / backward compat).
 */
export class NotificationService {
  private readonly localProviders = new Map<string, INotificationOutputProvider>()
  private readonly routing = new Map<string, NotificationTargetRef[]>()
  private readonly rateLimits = new Map<string, number>()
  private readonly lastSent = new Map<string, number>()
  private registry: ICapabilityRegistry | null = null

  constructor(private readonly logger: IScopedLogger) {}

  /** Set the registry for live provider lookup. Called once during boot. */
  setRegistry(registry: ICapabilityRegistry): void {
    this.registry = registry
  }

  /** Resolve the collection provider for an addon — registry first, then local map. */
  private resolveProvider(addonId: string): INotificationOutputProvider | undefined {
    if (this.registry) {
      return (
        this.registry.getProviderByAddon<INotificationOutputProvider>(
          'notification-output',
          addonId,
        ) ?? undefined
      )
    }
    return this.localProviders.get(addonId)
  }

  /** Register a provider in the local fallback map (used when no registry is set). */
  registerLocalProvider(addonId: string, provider: INotificationOutputProvider): void {
    this.localProviders.set(addonId, provider)
    this.logger.info('Notification provider added', { meta: { addonId } })
  }

  /** Remove a provider from the local fallback map. */
  unregisterLocalProvider(addonId: string): void {
    this.localProviders.delete(addonId)
    this.logger.info('Notification provider removed', { meta: { addonId } })
  }

  /** Route a category to a set of `(addonId, targetId)` targets. */
  setRouting(category: string, targets: readonly NotificationTargetRef[]): void {
    this.routing.set(category, [...targets])
  }

  setRateLimit(category: string, minIntervalMs: number): void {
    this.rateLimits.set(category, minIntervalMs)
  }

  async notify(notification: RoutedNotification): Promise<void> {
    const { category, deviceId } = notification

    // Rate limit check
    const rateLimitKey = deviceId ? `${category}:${deviceId}` : category
    const minInterval = this.rateLimits.get(category) ?? 0
    if (minInterval > 0) {
      const last = this.lastSent.get(rateLimitKey) ?? 0
      if (notification.timestamp - last < minInterval) {
        this.logger.debug('Rate limited', { meta: { rateLimitKey } })
        return
      }
    }

    // Determine target destinations
    const targets = this.routing.get(category) ?? this.routing.get('*') ?? []
    if (targets.length === 0) {
      this.logger.debug('No routing configured for category', { meta: { category } })
      return
    }

    // Update last-sent timestamp
    this.lastSent.set(rateLimitKey, notification.timestamp)

    // The cap `send` payload is the canonical Notification — strip the
    // consumer-side envelope fields (category / timestamp).
    const { category: _category, timestamp: _timestamp, ...canonical } = notification

    // Dispatch to all targets in parallel with error isolation
    await Promise.allSettled(
      targets.map(async (ref) => {
        const provider = this.resolveProvider(ref.addonId)
        if (!provider) {
          this.logger.debug('No provider for target', { meta: { addonId: ref.addonId } })
          return
        }
        try {
          await provider.send({ targetId: ref.targetId, notification: canonical })
        } catch (err) {
          this.logger.error('Notification target failed', {
            meta: { addonId: ref.addonId, targetId: ref.targetId, error: errMsg(err) },
          })
        }
      }),
    )

    return undefined
  }

  getRouting(): ReadonlyMap<string, NotificationTargetRef[]> {
    return this.routing
  }
}
