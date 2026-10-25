import { NotificationService } from '@camstack/system'
import type { RoutedNotification } from '@camstack/types'
import { CapabilityService } from '../capability/capability.service'
import { LoggingService } from '../logging/logging.service'

/**
 * NestJS-injectable wrapper around the core NotificationService.
 *
 * Lazily creates the NotificationService on first use, wiring in the
 * CapabilityRegistry for proxy-based output resolution.
 */
export class NotificationServiceWrapper {
  private _service: NotificationService | null = null

  constructor(
    private readonly caps: CapabilityService,
    private readonly logging: LoggingService,
  ) {}

  get service(): NotificationService {
    if (!this._service) {
      this._service = new NotificationService(this.logging.createLogger('notifications'))
      const registry = this.caps.getRegistry()
      if (registry) {
        this._service.setRegistry(registry)
      }
    }
    return this._service
  }

  async notify(notification: RoutedNotification): Promise<void> {
    return this.service.notify(notification)
  }
}
