/**
 * A stored wrapper activation that names a cap with NO wrapper any more.
 *
 * `deviceBindings[device][cap].wrapperAddonId` is the operator's choice of a
 * wrapper. When a wrapper is RETIRED (the `virtual-doorbell` on `doorbell`,
 * slice 6, D671), its rows outlive it: nothing deletes them (spec S1 — the
 * cluster is not written by code), and the admin UI no longer offers a toggle
 * for a cap that is not a wrapper cap. Routed as before, such a row shadows
 * the device's native (a composed doorbell) behind an addon that no longer
 * exists, keeps the cap advertised to HA / HAP / Alexa, and refuses every
 * call — without a line (task 17 review M1, D391).
 *
 * So the row is judged against the cap's DECLARED definition — static at boot,
 * never the live registry, because a wrapper runner that is still starting must
 * not read as stale. A string `wrapperAddonId` on a cap that is declared and is
 * not `kind: 'wrapper'` is treated as ABSENT: the cap resolves to its native
 * (or to nothing), exactly as if the row were not there. That loses no
 * doorbell: with a native, the native serves it; without one, the retired
 * addon could not serve it either. A cap this build does not declare is NOT
 * judged (unknown is not stale).
 *
 * It is said once per (device, cap) per process, by name, with the call that
 * clears the row. The whole store is checked once per process, read-only, so a
 * device nobody asks about is still named; a read that fails changes nothing,
 * says it could not check, and the next answered read checks instead (D49).
 * Generic on purpose: the next wrapper retirement gets the same backstop.
 */
import { ALL_CAPABILITY_DEFINITIONS, type IScopedLogger } from '@camstack/types'
import type { DeviceBindingsStore } from './device-meta-types.js'

const STALE_MESSAGE =
  'bindings: a stored wrapper activation names a cap with no wrapper — ignored, the cap resolves to its native'
const UNCHECKED_MESSAGE =
  'bindings: could not read the stored wrapper activations — retired-wrapper rows not checked'
const RECOVERY =
  'deviceManager.setWrapperActive({ deviceId, capName, wrapperAddonId, active: false })'

/**
 * Every cap this build declares that is NOT a wrapper cap — built once from
 * the static table: `getAllBindings` is a scheduled hot path, and step 1 asks
 * this for every stored string activation (re-review N2).
 */
const DECLARED_NON_WRAPPER_CAPS: ReadonlySet<string> = new Set(
  ALL_CAPABILITY_DEFINITIONS.filter((cap) => cap.kind !== 'wrapper').map((cap) => cap.name),
)

/**
 * Every COLLECTION cap this build declares — the static table, like the set
 * above, because a stored row must be judged the same whether or not a
 * provider of the cap is live yet (R1-L1).
 */
const DECLARED_COLLECTION_CAPS: ReadonlySet<string> = new Set(
  ALL_CAPABILITY_DEFINITIONS.filter((cap) => cap.mode === 'collection').map((cap) => cap.name),
)

/**
 * True when `capName` is a declared COLLECTION cap: its owners are derived by
 * `getBindings` step 0 and it persists no activation (D556), so a stored row
 * for it is never an owner.
 */
export function isDeclaredCollectionCap(capName: string): boolean {
  return DECLARED_COLLECTION_CAPS.has(capName)
}

/** True when `capName` is declared by this build and is NOT a wrapper cap. */
function isDeclaredNonWrapperCap(capName: string): boolean {
  return DECLARED_NON_WRAPPER_CAPS.has(capName)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A persisted activation of a wrapper on a cap that has none (see module docblock). */
export function isRetiredWrapperActivation(
  capName: string,
  wrapperAddonId: string | null | undefined,
): wrapperAddonId is string {
  return typeof wrapperAddonId === 'string' && isDeclaredNonWrapperCap(capName)
}

/**
 * The per-process memory: which (device, cap) rows have been said, and whether
 * the whole store has been checked once. Owned by the device-manager instance.
 */
export class StaleWrapperActivations {
  private readonly said = new Set<string>()
  private checked = false

  constructor(private readonly logger: IScopedLogger) {}

  /** Say one row, once per process. */
  report(deviceId: number, capName: string, wrapperAddonId: string): void {
    const key = `${deviceId}\u0000${capName}`
    if (this.said.has(key)) return
    this.said.add(key)
    this.logger.warn(STALE_MESSAGE, {
      tags: { deviceId },
      meta: { capName, wrapperAddonId, recovery: RECOVERY },
    })
  }

  /**
   * Check a store that was already READ (by a bindings pass) — once per
   * process. It never throws: it runs inside every bindings pass and under the
   * boot `void` promise, so a corrupt entry (a null device or row, a hand edit,
   * a partial write) is skipped — a row it cannot read is not one it can judge
   * (re-review N1).
   */
  checkStore(store: DeviceBindingsStore): void {
    if (this.checked) return
    this.checked = true
    const devices: unknown = store.deviceBindings
    if (!isRecord(devices)) return
    for (const [deviceKey, perDevice] of Object.entries(devices)) {
      const deviceId = Number(deviceKey)
      if (!Number.isInteger(deviceId) || !isRecord(perDevice)) continue
      for (const [capName, row] of Object.entries(perDevice)) {
        const wrapperAddonId = isRecord(row) ? row['wrapperAddonId'] : undefined
        if (typeof wrapperAddonId === 'string' && isDeclaredNonWrapperCap(capName)) {
          this.report(deviceId, capName, wrapperAddonId)
        }
      }
    }
  }

  /** Read the store (read-only) and check it; a failed read changes nothing. */
  async checkOnce(read: () => Promise<DeviceBindingsStore>): Promise<void> {
    if (this.checked) return
    let store: DeviceBindingsStore
    try {
      store = await read()
    } catch (err: unknown) {
      this.logger.warn(UNCHECKED_MESSAGE, {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    // `checkStore` does not throw by construction; this is the belt for the
    // boot `void` promise — a throw here is logged, never an unhandled rejection.
    try {
      this.checkStore(store)
    } catch (err: unknown) {
      this.logger.warn(UNCHECKED_MESSAGE, {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
