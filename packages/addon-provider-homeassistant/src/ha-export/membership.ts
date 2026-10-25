/**
 * Export membership — which device reaches which Home Assistant instance.
 *
 * A composite key (broker × device), because the operator chose per-broker
 * membership over one global list: two HA instances must be able to see
 * different sets of cameras.
 *
 * **This module is the AUTHORITY, and it is the only one.** The per-device
 * Export panel renders N switches over it — one per broker — and each of
 * them reads and writes exactly this store. There is deliberately no
 * second per-device HA opt-in anywhere: two switches that can disagree
 * are worse than one (D62), and this repo has already shipped two knobs
 * that wrote a store nobody read.
 *
 * Pure and immutable: every operation returns a new record.
 */

/** brokerId → the camstack device ids exported to it (as strings). */
export type ExportMembership = Readonly<Record<string, readonly string[]>>

export function devicesForBroker(
  membership: ExportMembership,
  brokerId: string,
): readonly string[] {
  return membership[brokerId] ?? []
}

export function isExposed(
  membership: ExportMembership,
  brokerId: string,
  deviceId: string,
): boolean {
  return devicesForBroker(membership, brokerId).includes(deviceId)
}

/** Every broker a device reaches. Drives the N switches in the panel. */
export function brokersExposing(membership: ExportMembership, deviceId: string): readonly string[] {
  return Object.keys(membership)
    .filter((brokerId) => isExposed(membership, brokerId, deviceId))
    .sort()
}

/** Every device exported to at least one of the given brokers. */
export function exposedDeviceIds(
  membership: ExportMembership,
  brokerIds: readonly string[],
): readonly string[] {
  const ids = new Set<string>()
  for (const brokerId of brokerIds) {
    for (const deviceId of devicesForBroker(membership, brokerId)) ids.add(deviceId)
  }
  return [...ids].sort()
}

export function setExposed(
  membership: ExportMembership,
  brokerId: string,
  deviceId: string,
  exposed: boolean,
): ExportMembership {
  const current = devicesForBroker(membership, brokerId)
  if (exposed === current.includes(deviceId)) return membership
  const next = exposed ? [...current, deviceId].sort() : current.filter((id) => id !== deviceId)
  return { ...membership, [brokerId]: next }
}

/**
 * Forget brokers that no longer exist.
 *
 * A removed HA instance must not keep a membership list that reappears if
 * a broker id is ever reused — and a stale key would also inflate
 * `exposedDeviceCount` with devices going nowhere.
 */
export function pruneBrokers(
  membership: ExportMembership,
  knownBrokerIds: readonly string[],
): ExportMembership {
  const known = new Set(knownBrokerIds)
  const kept = Object.keys(membership).filter((brokerId) => known.has(brokerId))
  if (kept.length === Object.keys(membership).length) return membership
  const next: Record<string, readonly string[]> = {}
  for (const brokerId of kept) next[brokerId] = membership[brokerId] ?? []
  return next
}

/**
 * The brokers the operator has switched ON, read from the RAW addon store.
 *
 * `exportTo:<brokerId>` is a **dynamic** settings key — one per broker the
 * hub happens to know about — so it can never appear in the addon's
 * `DEFAULT_CONFIG`. `BaseAddon.resolveConfig` copies only keys that are
 * present in the defaults ("the store can contain extra keys … without
 * polluting the typed config"), so every `exportTo:*` key is dropped on the
 * way into `this.config` and reading one there yields `undefined` for ever.
 *
 * That is not theoretical. On 2026-08-09 the switch was on
 * (`getGlobalSettings` returned `exportTo:ha_001 → value: true`, because the
 * settings FORM reads the store) and every reconcile still logged
 * `brokers=0`: nothing was ever exported, the per-device Export tab rendered
 * its "Not configured" card, and no operator action could have changed
 * either. The store is the single authority — read it, do not mirror it into
 * a typed field that would then be a second one (D62).
 *
 * A broker that is no longer known is not enabled, whatever the store says:
 * a stale `exportTo:` key for a deleted instance must not resurrect it.
 */
export function enabledBrokerIds(
  store: Readonly<Record<string, unknown>>,
  knownBrokerIds: readonly string[],
): readonly string[] {
  return knownBrokerIds.filter((brokerId) => store[`exportTo:${brokerId}`] === true)
}

/** A broker the operator can tick. Cached so the settings form can render. */
export interface KnownBroker {
  readonly id: string
  readonly name: string
}

/** Same brokers, same order, same names — nothing for the form to re-render. */
export function sameBrokers(a: readonly KnownBroker[], b: readonly KnownBroker[]): boolean {
  if (a.length !== b.length) return false
  return a.every((broker, index) => {
    const other = b[index]
    return other !== undefined && other.id === broker.id && other.name === broker.name
  })
}

/**
 * The two settings keys a broker refresh may write.
 *
 * A type ALIAS rather than an interface, deliberately: the addon config it
 * patches carries an index signature for the dynamic `exportTo:<brokerId>`
 * keys, and only an object-literal type gets the implicit index signature that
 * makes it assignable to `Partial<HaExportConfig>`.
 */
export type BrokerRefreshPatch = {
  readonly knownBrokers?: readonly KnownBroker[]
  readonly membership?: ExportMembership
}

/** The half of the addon config a broker refresh compares against. */
export interface BrokerRefreshState {
  readonly knownBrokers: readonly KnownBroker[]
  readonly membership: ExportMembership
}

/**
 * What a broker refresh persists — and, above all, what it must NOT.
 *
 * **A patch never names a key it did not change.** That reads like tidiness
 * and is not: `updateGlobalSettings` is a read-modify-write over the addon
 * store, so naming `membership` writes whatever `this.config.membership`
 * currently holds — and `this.config` is not always the store.
 * `BaseAddon.resolveConfig` falls back to the CONSTRUCTOR DEFAULTS whenever
 * the settings read answers empty, and the kernel's `readAddonStore` answers
 * empty for a FAILED read exactly as it does for a missing one, silently. A
 * boot-window read that misses therefore gives the addon `membership: {}`,
 * and the first refresh that merely re-records `knownBrokers` hands that
 * empty object to the store as if the operator had unexported everything.
 *
 * That is not a hypothetical. On 2026-08-24 the hub restarted at 21:49; the
 * export runner came up while the cap resolver was still answering
 * "no provider registered" for hub-resident caps; at 21:55:13 a refresh
 * found `knownBrokers` stale (`[]` vs `[ha_001]`) and wrote BOTH keys. The
 * two exported cameras (104 hall, 101 front door) were erased from the
 * store, `devices` fell from 4 to 2 (the two synthetic devices), and Home
 * Assistant kept every camera entity as a restored/unavailable orphan for
 * three days: no stream ("the hub does not export this camera"), no
 * doorbell, no camera state. Nothing logged it, because from the store's
 * point of view the addon simply asked for `{}`.
 *
 * With the keys split, that pass writes `knownBrokers` alone, the
 * `resolveConfig` that follows the write re-reads a store that still holds
 * the membership, and the next reconcile exports both cameras again.
 *
 * Identity, not deep equality, decides `membership`: `pruneBrokers` returns
 * the SAME reference when it removed nothing, which is precisely the
 * "nothing changed" signal this needs.
 *
 * @returns the patch to persist, or `null` when there is nothing to write.
 */
export function brokerRefreshPatch(
  current: BrokerRefreshState,
  next: BrokerRefreshState,
): BrokerRefreshPatch | null {
  const brokersChanged = !sameBrokers(next.knownBrokers, current.knownBrokers)
  const membershipChanged = next.membership !== current.membership
  if (!brokersChanged && !membershipChanged) return null
  return {
    ...(brokersChanged ? { knownBrokers: next.knownBrokers } : {}),
    ...(membershipChanged ? { membership: next.membership } : {}),
  }
}
