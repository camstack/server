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

const KBPS_PER_MBPS = 1000

/**
 * `network-link`: an Ethernet link — whether it is up, and the negotiated speed in the
 * `bitrate` base unit (kbps; the controller reports Mbps). Not reported is `null`.
 */
export function portNetworkLinkStatus(port: UnifiInfraPort, now: number): NetworkLinkStatus {
  return {
    type: 'ethernet',
    signal: null,
    linkUp: port.linkUp,
    speedKbps: port.speedMbps === null ? null : port.speedMbps * KBPS_PER_MBPS,
    lastUpdated: now,
  }
}
