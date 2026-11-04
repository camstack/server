import { BaseDevice, type DeviceContext, type DeviceFeature, DeviceType } from '@camstack/types'
import { VESYNC_SYSTEM, vesyncGatewaySchema } from '../config.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'

/**
 * The VeSync account as a {@link DeviceType.Gateway}. Its credentials live on the
 * integration; this device is the account's presence in the device list. Purifiers are
 * siblings, not children. The cloud account has no local page, reboot or update, so the
 * device registers no capability of its own. Online follows the integration's client.
 */
export class VeSyncGatewayDevice extends BaseDevice<typeof vesyncGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string

  constructor(ctx: DeviceContext) {
    const cfg = vesyncGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncGatewaySchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = vesyncAccounts.getManager(this.integrationId)?.status === 'connected'
    void this.updateSourceInfo({
      id: `${this.integrationId}:account`,
      system: VESYNC_SYSTEM,
    })
  }
}
