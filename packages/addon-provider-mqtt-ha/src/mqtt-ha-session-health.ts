import { IntegrationSessionReporter, type SessionLossReason } from '@camstack/types'
import { MqttHaBrokerFault } from './mqtt-ha-broker-session.js'

export function classifyMqttHaSessionError(err: unknown): SessionLossReason | null {
  if (!(err instanceof MqttHaBrokerFault)) return null
  return err.kind === 'auth-refused' ? 'auth-rejected' : 'broker-unavailable'
}

/**
 * Process-wide entry the broker sessions report to (through the addon, which maps
 * a broker to its integrations); the addon binds it once. The standard
 * "connection lost" alert is raised after the debounce and clears on `ok`.
 */
export const mqttHaSession = new IntegrationSessionReporter({
  kind: 'mqtt-ha',
  providerName: 'MQTT',
  classify: classifyMqttHaSessionError,
})
