/**
 * Baichuan network readout → the `network-link` slice.
 *
 * The firmware reports the active link as a label (`"Wifi"`, `"LAN"`, …,
 * `getNetworkInfo`) plus, on wireless, a `signal` (`getWifiSignal`) whose
 * SCALE the protocol does not state: the app draws it as four bars, Reolink's
 * CGI documents `GetWifiSignal` as 0–4, and some firmwares are reported to
 * answer with a percent or an RSSI. The mapping reads the shape of the number
 * rather than trusting one scale — 0..4 is bars, 5..100 is a percent,
 * negative is dBm — and anything else is NOT a reading (`null`), never a
 * guess. The raw value is kept in the read's debug line so a wrong scale
 * shows up as a number, not as a silent 25 %.
 */
import {
  type NetworkLinkStatus,
  type NetworkLinkType,
  signalPercentFromBars,
  signalPercentFromRssi,
} from '@camstack/types'

export interface NetworkReadout {
  /** `getNetworkInfo().activeLink` — a firmware label, absent on some models. */
  readonly activeLink: string | undefined
  /** `getWifiSignal().signal` — only asked on a wireless link. */
  readonly wifiSignal: number | undefined
  /** `getWifi().ssid` — only asked on a wireless link. */
  readonly ssid: string | undefined
}

/** Reolink's wireless signal as the app draws it: four bars. */
export const REOLINK_WIFI_SIGNAL_BARS = 4

/**
 * The link the label names. A label the firmware did not give is `unknown`,
 * UNLESS the camera also named the network it joined — an SSID is a joined
 * wifi link whatever the label says. A bare signal number is NOT enough:
 * measured 2026-09-06, an E1 Outdoor PoE on its cable answered
 * `getWifiSignal` with -10 and no SSID, and -10 dBm is not a wifi reading.
 */
export function linkTypeOf(readout: Pick<NetworkReadout, 'activeLink' | 'ssid'>): NetworkLinkType {
  const label = (readout.activeLink ?? '').toLowerCase()
  if (label.includes('wifi') || label.includes('wlan') || label.includes('wireless')) return 'wifi'
  if (label.includes('lan') || label.includes('eth') || label.includes('wire')) return 'ethernet'
  if (/\b(4g|5g|lte|cell|sim)\b/.test(label)) return 'cellular'
  if (readout.ssid !== undefined && readout.ssid !== '') return 'wifi'
  return 'unknown'
}

/** True when the label names a wireless link — the only case worth a signal read. */
export function isWirelessLabel(activeLink: string | undefined): boolean {
  const type = linkTypeOf({ activeLink, ssid: undefined })
  return type === 'wifi' || type === 'cellular'
}

/** 0..4 → bars; 5..100 → percent; negative → dBm; anything else → not a reading. */
export function signalPercentOf(raw: number | undefined): number | null {
  if (raw === undefined || !Number.isFinite(raw)) return null
  if (raw < 0) return signalPercentFromRssi(raw)
  if (raw <= REOLINK_WIFI_SIGNAL_BARS) return signalPercentFromBars(raw, REOLINK_WIFI_SIGNAL_BARS)
  if (raw <= 100) return Math.round(raw)
  return null
}

export function mapNetworkReadout(readout: NetworkReadout, now: number): NetworkLinkStatus {
  const type = linkTypeOf(readout)
  const raw = readout.wifiSignal
  const wireless = type === 'wifi' || type === 'cellular'
  const signal = wireless ? signalPercentOf(raw) : null
  const rssiDbm = wireless && raw !== undefined && Number.isFinite(raw) && raw < 0 ? raw : undefined
  const ssid =
    wireless && readout.ssid !== undefined && readout.ssid !== '' ? readout.ssid : undefined
  return {
    type,
    signal,
    ...(rssiDbm !== undefined ? { rssi: rssiDbm } : {}),
    ...(ssid !== undefined ? { ssid } : {}),
    lastUpdated: now,
  }
}
