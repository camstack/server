import {
  updateCapability,
  type DeviceContext,
  type InferNativeProvider,
  type UpdateStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import type { HaEntityState } from '../ha-types.js'

const UPDATE_CAP = 'update'

const COLD_START: UpdateStatus = {
  currentVersion: null,
  availableVersion: null,
  // A real HA update entity is updatable by definition; `false` is not a valid
  // runtime state and would flash "doesn't support updates" before the first push.
  updatable: true,
  state: null,
  inProgress: false,
}

/**
 * HA-backed firmware/software update device. One cap (`update`) surfacing
 * the current vs available version, an availability flag, the verbatim HA
 * state string and an install action.
 *
 * HA `update.*` entity semantics:
 *   - `state === 'on'`  → an update IS available.
 *   - `state === 'off'` → up to date.
 *   - attributes: `installed_version` → currentVersion,
 *     `latest_version` → availableVersion,
 *     `in_progress` (boolean OR legacy percentage number) / `update_percentage`
 *     (0–100, null when idle) → inProgress. See `readInProgress` for why this is
 *     gated on an update actually being available.
 *
 * `updatable` is set to `true` (the entity supports updates). The UI decides
 * "update available" from `availableVersion !== currentVersion`, so the
 * version attributes are always populated regardless of `updatable`.
 */
export class HaUpdateDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerUpdateCap()
    this.runtimeState.setCapState(UPDATE_CAP, COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const currentVersion = readStringAttr(state.attributes, 'installed_version')
    const availableVersion = readStringAttr(state.attributes, 'latest_version')
    const inProgress = readInProgress(state)
    this.runtimeState.setCapState(UPDATE_CAP, {
      currentVersion,
      availableVersion,
      updatable: true,
      state: state.state,
      inProgress,
    })
  }

  private registerUpdateCap(): void {
    const provider: InferNativeProvider<typeof updateCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<UpdateStatus>(UPDATE_CAP) ?? COLD_START
      },
      installUpdate: async () => {
        await this.callHaService('update', 'install')
      },
    }
    this.ctx.registerNativeCap(updateCapability, provider)
  }
}

/**
 * Decide whether a firmware/software install is genuinely running.
 *
 * An install can only be in progress while an update is actually available
 * (`state === 'on'`, i.e. installed_version !== latest_version). Several HA
 * firmware-update integrations leave `in_progress` pinned at `true` even when
 * the entity is `off` and up to date (installed_version == latest_version) —
 * surfacing that verbatim shows a permanent ghost "Installing…" for an update
 * that does not exist (the device 880 firmware bug: state `off`, versions equal,
 * `in_progress: true`). Gating on `state === 'on'` suppresses it.
 *
 * When an update IS available, "installing" is signalled by either the legacy
 * boolean / numeric `in_progress` attribute or the modern `update_percentage`
 * (0–100, null when idle).
 */
function readInProgress(state: HaEntityState): boolean {
  if (state.state !== 'on') return false
  const raw = state.attributes['in_progress']
  if (raw === true) return true
  if (typeof raw === 'number' && raw > 0) return true
  const pct = state.attributes['update_percentage']
  if (typeof pct === 'number' && pct > 0) return true
  return false
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' ? v : null
}
