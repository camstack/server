/**
 * The cap slices of one PoE port device, derived from its port in the infra snapshot. Pure.
 */
import type { NetworkLinkStatus, PowerMeterStatus, SwitchStatus } from '@dominevo/types'
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

/** Whether an infra device has at least one PoE-capable port (the gate for its own `power-meter`). */
export function hasPoePort(ports: readonly UnifiInfraPort[]): boolean {
  return ports.some((port) => port.poeCapable)
}

/**
 * `power-meter` of the infra device itself: the PoE power it DELIVERS to connected devices (the
 * sum of its PoE ports' draw), reported as `deliveredPower`; `power` (the device's own total
 * draw) stays unset, UniFi reports none. The controller's per-device
 * payload is not forwarded by any client, so the total is the sum of the ports that reported a
 * reading; a port that did not is unknown, and when none reported the total is absent (D393),
 * never 0.
 */
export function infraPoeTotalStatus(
  ports: readonly UnifiInfraPort[],
  now: number,
): PowerMeterStatus {
  const readings = ports.flatMap((port) => (port.poePowerW === null ? [] : [port.poePowerW]))
  if (readings.length === 0) return { lastFetchedAt: now }
  return { deliveredPower: readings.reduce((sum, w) => sum + w, 0), lastFetchedAt: now }
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
