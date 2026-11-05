import type { MqttExternalBrokerEntry } from './mqtt-external-broker-entry.js'

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * The external broker entry after `setSettings`: a field the settings carry replaces the stored
 * one, an absent or empty password keeps the stored one (the form never sees it). An onboard
 * entry owns a listening server, so its address is not editable here: remove it and add a new one.
 */
export function applyMqttBrokerSettings(
  entry: MqttExternalBrokerEntry,
  settings: Readonly<Record<string, unknown>>,
): MqttExternalBrokerEntry {
  if (entry.onboard !== undefined) {
    throw new Error(
      `mqtt-broker: broker '${entry.id}' is an onboard broker; remove it and add a new one`,
    )
  }
  const url = textOf(settings['url'])
  if (url !== undefined && url.length === 0)
    throw new Error('mqtt-broker.setSettings: url cannot be blank')
  const username = textOf(settings['username'])
  const password = textOf(settings['password'])
  const clientIdPrefix = textOf(settings['clientIdPrefix'])
  const kept = password === undefined || password.length === 0 ? entry.password : password
  return {
    ...entry,
    ...(url !== undefined ? { url } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(clientIdPrefix !== undefined ? { clientIdPrefix } : {}),
    ...(kept !== undefined ? { password: kept } : {}),
  }
}
