/**
 * The cap slices of one PoE port device, derived from its port in the infra snapshot. Pure.
 */
import type { NetworkLinkStatus, PowerMeterStatus, SwitchStatus } from '@camstack/types'
import type { UnifiInfraPort } from './unifi-client-contract.js'

/** `switch`: PoE on (the port's PoE mode is not `off`). */
export function portSwitchStatus(port: UnifiInfraPort, now: number): SwitchStatus {
  return { on: port.poeOn, lastChangedAt: now }
}

/** `power-meter`: the PoE draw; a reading the controller did not report is absent, never 0. */
export function portPowerStatus(port: UnifiInfraPort, now: number): PowerMeterStatus {
  return {
    ...(port.poePowerW !== null ? { power: port.poePowerW } : {}),
    ...(port.poeVoltageV !== null ? { voltage: port.poeVoltageV } : {}),
    ...(port.poeCurrentA !== null ? { current: port.poeCurrentA } : {}),
    lastFetchedAt: now,
  }
}

/**
 * `network-link`: an Ethernet link. The cap has no link-up or speed field yet; both are on the
 * port snapshot (`linkUp`, `speedMbps`) for the cap fields being added (planning#583).
 */
export function portNetworkLinkStatus(_port: UnifiInfraPort, now: number): NetworkLinkStatus {
  return { type: 'ethernet', signal: null, lastUpdated: now }
}
