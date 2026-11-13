import type { KeyChannelLink } from '../ccu/ccu-schemas.js'

/** i18n key under `provider-homematic:` for a CCU key channel's central-link state. */
export function centralKey(
  central: KeyChannelLink['central'],
): 'devices.buttonEventsOn' | 'devices.buttonEventsOff' | 'devices.buttonEventsUnknown' {
  if (central === 'on') return 'devices.buttonEventsOn'
  if (central === 'off') return 'devices.buttonEventsOff'
  return 'devices.buttonEventsUnknown'
}
