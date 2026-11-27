import { IntegrationSessionReporter, type SessionLossReason } from '@camstack/types'

/** The Zigbee2MQTT link ended for a reason the operator can act on. */
export class Z2mSessionFault extends Error {
  constructor(
    readonly reason: SessionLossReason,
    message: string,
  ) {
    super(message)
    this.name = 'Z2mSessionFault'
  }
}

export function classifyZ2mSessionError(err: unknown): SessionLossReason | null {
  return err instanceof Z2mSessionFault ? err.reason : null
}

/** Process-wide entry the connections report to; the addon binds it once. */
export const z2mSessionHealth = new IntegrationSessionReporter({
  kind: 'zigbee2mqtt',
  providerName: 'Zigbee2MQTT',
  classify: classifyZ2mSessionError,
})
