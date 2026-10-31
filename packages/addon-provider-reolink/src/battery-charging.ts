import type { BatteryStatus } from '@camstack/types'

/**
 * From `adapterStatus` + `chargeStatus` to the power source.
 *
 * The two fields answer TWO different questions, and confusing them is the bug that
 * this module exists to close:
 *
 *  - `adapterStatus` — is the power CONNECTED? The firmware sends 0/1/2
 *    (none · DC adapter · solar panel) and the hub boundary
 *    translates it into `'none' | 'dc' | 'solarPanel'` (`mapHubChargeStatus` and
 *    `mapHubAdapterStatus` in `reolink-hub-session.ts`), because the vocabulary of the
 *    standalone path is already strings.
 *  - `chargeStatus` — what is the CELL doing? 0 stopped · 1 charging ·
 *    2 fully charged.
 *
 * The old derivation consulted the adapter ONLY to look for 'solar' in it, and
 * a connected DC fell into the fallback `'none'`. Two Argus 3E units hid it by
 * chance: full and connected they answer `chargeStatus: 2`, which the `isCharging`
 * branch mapped to `'dc'` for the wrong reason. The Argus MagiCam (batteryVersion
 * 1, firmware 2026) permanently connected answers `chargeStatus: 0`, and for
 * its whole life it was reported as NOT charging.
 *
 * That `adapterStatus` is a real signal and not a constant is MEASURED: on
 * 2026-09-05 the operator unplugged device 3628 and the raw payload
 * went from `adapterStatus: 1` to `0`, with `chargeStatus: 0` on both
 * sides — i.e. `chargeStatus` alone does NOT distinguish the two states.
 *
 * Two absent fields are NOT `'none'`: `'none'` is a negative the firmware
 * has stated ("no adapter, cell stopped"), the absence of both is
 * `'unknown'` — the same boundary `percentage` closed by becoming
 * `nullable` (D315). The caller (`mapBatteryInfo`) does not arrive here with a
 * push that says nothing about power: `reportsPowerSource` filters it out first and
 * keeps the previous belief.
 */
export function deriveChargingSource(
  adapterStatus: string | undefined,
  chargeStatus: string | undefined,
): BatteryStatus['charging'] {
  if (adapterStatus === undefined && chargeStatus === undefined) return 'unknown'
  const adapter = (adapterStatus ?? '').toLowerCase()
  const charge = (chargeStatus ?? '').toLowerCase()
  // The panel is the SOURCE and wins over the cell: a solar battery
  // charging is powered by the sun, not by the grid.
  if (adapter.includes('solar')) return 'solar'
  // Mains connected: true regardless of what the cell does — full,
  // charging or stopped. This is the branch that was missing.
  if (adapter === 'dc') return 'dc'
  // No adapter reported (or the field is missing altogether): only the
  // cell signal remains, which is how the older firmwares behaved.
  if (charge === 'charging' || charge === 'chargecomplete') return 'dc'
  return 'none'
}

export interface PowerSourceFields {
  readonly adapterStatus?: string | undefined
  readonly chargeStatus?: string | undefined
}

/**
 * Did this reading SAY anything about the power source? A battery push may
 * carry only the level (every `BatteryInfo` field is optional and nodelink
 * dispatches as soon as one is present); a caller that derives `charging`
 * from such a push turns "nothing was said" into 'none' and overwrites a known
 * 'dc'. When this is false the caller keeps its previous belief.
 */
export function reportsPowerSource(info: PowerSourceFields): boolean {
  return info.adapterStatus !== undefined || info.chargeStatus !== undefined
}
