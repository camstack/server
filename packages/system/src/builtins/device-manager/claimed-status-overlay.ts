/**
 * The device-manager's side of the claimed-status overlay (D663, ruling S3):
 * the `CapabilityRegistry` asks "is `(cap, device)` claimed, and what does the
 * merge say?" and the answer comes from the mirror's `effectiveIfClaimed` —
 * once the device's claims are KNOWN.
 *
 * Knowing them is the point (D315, D49). The mirror seeds a device lazily, on
 * its provider's first native write, so from hub boot until then
 * `effectiveIfClaimed` is `null` for every device — and `null` read as
 * "unclaimed" would hand every caller the native value of a claimed cap for as
 * long as a sleeping battery camera takes to report (an hour, per boot), then
 * swap it under them. So:
 *   - `peek` (synchronous, the registry's resolve-time question) answers from
 *     what is known: a seeded device from its merge; an unseeded device the
 *     LOADED claims index does not name is KNOWN unclaimed (and marked seeded,
 *     as `ensureSeeded` would); anything else is `unknown`.
 *   - `resolve` (awaited on the `getStatus` call path) makes the claims known
 *     first — `ensureSeeded`: the index, and when it cannot vouch for the
 *     device, its row read once, single-flight — then answers from the merge.
 *     A row that cannot be read stays `unknown`, which every consumer answers
 *     as "not reported", never the native; the mirror logs that refusal once
 *     per device.
 *
 * A cap that declares no `runtimeState` can never be claimed — claims live
 * only on runtime-state slices — so it is answered `unclaimed` before either
 * question is asked (final review M-2): no row read on its call path while the
 * index is not loaded (D447), and no false "unknown" while the row is
 * unreadable (D315).
 *
 * Installed once at init, over the mirror and index the addon owns; the
 * returned uninstall runs on shutdown so a registry that outlives this addon
 * does not keep asking a dead mirror.
 */
import type { ICapabilityRegistry, IScopedLogger, StatusOverlayAnswer } from '@camstack/types'
import type { DeviceManagerSettings } from './device-meta-store.js'
import { defaultSchemaFor } from './device-state-claim-views.js'
import type { ClaimsIndexView, DeviceStateMirror } from './device-state-mirror.js'

const UNCLAIMED: StatusOverlayAnswer = { kind: 'unclaimed' }
const UNKNOWN: StatusOverlayAnswer = { kind: 'unknown' }

export interface ClaimedStatusOverlayDeps {
  readonly mirror: DeviceStateMirror
  /** The claims index as it is NOW — loaded or not; read at every question, never captured. */
  readonly claimsIndex: () => ClaimsIndexView
  /** The settings door the mirror reads a device's row through. */
  readonly settings: () => DeviceManagerSettings
  readonly logger: IScopedLogger
}

function fromMerge(
  mirror: DeviceStateMirror,
  deviceId: number,
  capName: string,
): StatusOverlayAnswer {
  const merged = mirror.effectiveIfClaimed(deviceId, capName)
  if (merged === null) return UNCLAIMED
  return { kind: 'claimed', slice: merged.kind === 'slice' ? merged.slice : null }
}

export function installClaimedStatusOverlay(
  registry: ICapabilityRegistry,
  deps: ClaimedStatusOverlayDeps,
): () => void {
  const { mirror } = deps
  // Once per install (M-3): while the index is not loaded, every device's first
  // getStatus resolves its claims from its ROW — legible as one line, not N.
  let rowResolutionNoted = false
  const noteRowResolution = (deviceId: number): void => {
    if (rowResolutionNoted || deps.claimsIndex().state === 'loaded') return
    rowResolutionNoted = true
    deps.logger.info(
      'claims index not loaded: unseeded devices resolve their claims from the row on first getStatus (single-flight per device)',
      { tags: { deviceId } },
    )
  }
  registry.setStatusOverlay({
    peek(capName, deviceId): StatusOverlayAnswer {
      if (defaultSchemaFor(capName) === null) return UNCLAIMED
      if (mirror.isSeeded(deviceId)) return fromMerge(mirror, deviceId, capName)
      // Synchronous on purpose: a sync path holds no promise that can reject
      // (an in-flight seed's failed read would surface as an untagged
      // unhandledRejection on hub-main, N-1). A LOADED index that does not
      // name the device vouches for it — seeded, no read, one lookup next
      // time — but NOT while a read is in flight: that read may be landing a
      // claim the index does not know yet, so the device stays unknown until
      // it settles, never a transient native (M-5).
      if (mirror.seedIfIndexClears(deviceId, deps.claimsIndex())) return UNCLAIMED
      return UNKNOWN
    },
    async resolve(capName, deviceId): Promise<StatusOverlayAnswer> {
      if (defaultSchemaFor(capName) === null) return UNCLAIMED
      if (!mirror.isSeeded(deviceId)) {
        noteRowResolution(deviceId)
        try {
          await mirror.ensureSeeded(deviceId, deps.settings(), deps.claimsIndex())
        } catch {
          // Logged once per device by the mirror (SEED_REFUSAL_MESSAGE, D391).
          // Unknown is the truth; "not reported" is what consumers answer.
          return UNKNOWN
        }
      }
      return fromMerge(mirror, deviceId, capName)
    },
  })
  return () => registry.setStatusOverlay(null)
}
