/**
 * Names chosen when an integration or a Gateway device is created.
 * A stored name is never rewritten from these helpers.
 */

const HOME_SUFFIX = 'Home'
const MQTT_LABEL = 'MQTT'

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** "KLF-200" → "KLF200". A hyphen between words ("Home Hub") stays. */
function compactModelToken(value: string): string {
  return value.replace(/([A-Za-z])-(\d)/g, '$1$2')
}

/** Prefill for a new integration: "<provider> - Home". The operator can edit it. */
export function defaultIntegrationName(providerLabel: string): string {
  const label = collapse(providerLabel)
  if (label.length === 0) return HOME_SUFFIX
  return `${label} - ${HOME_SUFFIX}`
}

/**
 * An MQTT broker is named after the product that uses it ("MQTT - Zigbee2MQTT").
 * The generic transport id `mqtt` is not a product, so that case stays on
 * {@link defaultIntegrationName}.
 */
export function mqttBrokerIntegrationName(brokerKind: string): string {
  return `${MQTT_LABEL} - ${collapse(brokerKind)}`
}

export interface PrefilledIntegrationNameInput {
  readonly providerLabel: string
  readonly mode: 'standalone' | 'account' | 'broker'
  readonly brokerKind?: string | null
}

/** The name a new integration is created with, before the operator edits it. */
export function prefilledIntegrationName(input: PrefilledIntegrationNameInput): string {
  const label = collapse(input.providerLabel)
  const kind = input.brokerKind?.trim() ?? ''
  if (
    input.mode === 'broker' &&
    label === MQTT_LABEL &&
    kind.length > 0 &&
    kind.toLowerCase() !== 'mqtt'
  ) {
    return mqttBrokerIntegrationName(kind)
  }
  return defaultIntegrationName(label)
}

/**
 * A Gateway device: "<Brand> <Model>". An unknown model is the brand alone
 * (the caller passes the brand-level fallback it already has, e.g. "Velux KLF-200").
 */
export function gatewayDeviceName(brand: string, model?: string | null): string {
  const brandPart = compactModelToken(collapse(brand))
  const raw = collapse(model ?? '')
  if (raw.length === 0) return brandPart
  const modelPart = compactModelToken(raw)
  const prefix = `${brandPart.toLowerCase()} `
  if (modelPart.toLowerCase() === brandPart.toLowerCase()) return brandPart
  if (modelPart.toLowerCase().startsWith(prefix)) return modelPart
  return `${brandPart} ${modelPart}`
}
