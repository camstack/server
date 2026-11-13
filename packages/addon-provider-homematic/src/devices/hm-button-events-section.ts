import type { ConfigFieldWithValue, ConfigSectionWithValues } from '@camstack/types'
import type { KeyDirectLink } from '../ccu/ccu-schemas.js'

const ADDON_ID = 'provider-homematic'
const NS = 'provider-homematic:device.buttonEvents'

/** What the device knows about one of its key channels, read from the CCU. */
export interface HmKeyLinkState {
  readonly address: string
  /** CCU channel name, else `null` (the label then falls back to the key number). */
  readonly name: string | null
  readonly index: string
  /** `null`: the read failed — never shown as "off". */
  readonly central: boolean | null
  readonly links: readonly KeyDirectLink[]
}

function keyLabel(key: HmKeyLinkState): string {
  return key.name ?? `Key ${key.index}`
}

function linkText(link: KeyDirectLink): string {
  const target = link.receiverName ?? link.receiverDeviceName
  return target === null ? link.receiver : `${target} (${link.receiver})`
}

function statusOf(central: boolean | null): 'ok' | 'warn' | 'unknown' {
  if (central === null) return 'unknown'
  return central ? 'ok' : 'warn'
}

function toggleButton(integrationId: string, key: HmKeyLinkState): ConfigFieldWithValue {
  const enable = key.central !== true
  const label = keyLabel(key)
  return {
    type: 'addon-action-button',
    key: `buttonEvents_${key.address}`,
    label,
    addonId: ADDON_ID,
    action: 'setButtonEvents',
    paramsStatic: { integrationId, address: key.address, enabled: enable, confirmed: true },
    buttonLabel: enable ? 'Send presses to CamStack' : 'Stop sending presses',
    variant: enable ? 'primary' : 'default',
    confirmMessage: enable
      ? `Create the central link of "${label}" on the CCU? Its direct links stay as they are.`
      : `Remove the central link of "${label}" on the CCU? CamStack stops receiving its presses; its direct links stay as they are.`,
  }
}

/**
 * The device-page section of a Homematic button device: per key, whether the
 * CCU sends its presses to CamStack (the central link), the channels it
 * actuates directly, and a confirmed toggle that writes the central link.
 * Empty when the device has no key channel the CCU answered for.
 */
export function buttonEventsSection(
  integrationId: string | undefined,
  keys: readonly HmKeyLinkState[],
): ConfigSectionWithValues[] {
  if (integrationId === undefined || keys.length === 0) return []
  const missing = keys.some((key) => key.central === false)
  const fields: ConfigFieldWithValue[] = []
  if (missing) {
    fields.push({
      type: 'info',
      key: 'buttonEventsHint',
      label: 'Button events',
      labelKey: `${NS}.hint.label`,
      content: 'The CCU does not send some of these presses — turn them on below',
      contentKey: `${NS}.hint.content`,
      variant: 'warning',
    })
  }
  fields.push({
    type: 'object-array',
    key: 'buttonEventsKeys',
    label: 'Keys',
    labelKey: `${NS}.keys.label`,
    columns: [
      { key: 'key', label: 'Key', labelKey: `${NS}.keys.key` },
      { key: 'central', label: 'Sent to CamStack', labelKey: `${NS}.keys.central`, kind: 'status' },
      { key: 'links', label: 'Direct links', labelKey: `${NS}.keys.links` },
    ],
    value: keys.map((key) => ({
      key: keyLabel(key),
      central: statusOf(key.central),
      links: key.links.length === 0 ? '—' : key.links.map(linkText).join(', '),
    })),
  })
  for (const key of keys) {
    if (key.central !== null) fields.push(toggleButton(integrationId, key))
  }
  return [
    {
      id: 'button-events',
      title: 'Button events',
      titleKey: `${NS}.title`,
      columns: 1,
      fields,
    },
  ]
}
