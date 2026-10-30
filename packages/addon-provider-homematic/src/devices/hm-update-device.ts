import {
  updateCapability,
  type DeviceContext,
  type InferNativeProvider,
  type UpdateStatus,
} from '@camstack/types'
import type { HmDevice } from 'nodehomematic'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'

/** Update child config: just the device address + integration (no channel). */
export const hmUpdateSchema = hmChildSchema

/** Cold-start update status before the descriptor resolves. */
const COLD_UPDATE: UpdateStatus = {
  currentVersion: null,
  availableVersion: null,
  updatable: false,
  state: null,
  inProgress: false,
}

/** A CCU firmware-update lifecycle state is "in progress" when it is neither
 *  up-to-date nor an idle/unknown marker. The library forwards the raw
 *  `FIRMWARE_UPDATE_STATE` descriptor verbatim. */
function isInProgress(state: string | undefined): boolean {
  if (state === undefined) return false
  const s = state.toUpperCase()
  return s !== 'UP_TO_DATE' && s !== 'IDLE' && s !== 'UNKNOWN' && s.length > 0
}

/** Read the live `update` status off the device's firmware descriptor fields. */
function readUpdateStatus(device: HmDevice | null): UpdateStatus {
  if (!device) return COLD_UPDATE
  return {
    currentVersion: device.firmware ?? null,
    availableVersion: device.availableFirmware ?? null,
    updatable: device.updatable ?? false,
    state: device.firmwareUpdateState ?? null,
    inProgress: isInProgress(device.firmwareUpdateState),
  }
}

/**
 * One Homematic firmware Update accessory child (DeviceType.Update). The
 * `update` cap reads its status LIVE off the device's CCU descriptor fields
 * (`firmware` / `availableFirmware` / `updatable` / `firmwareUpdateState`) each
 * call — read-mostly is fine, the CCU descriptor is the source of truth.
 * `installUpdate` triggers the CCU update via the facade `installFirmware`.
 */
export class HmUpdateDevice extends HmChildDevice<typeof hmUpdateSchema> {
  /** Unsubscribes for the firmware re-read triggers (`ready` / `connection`). */
  private firmwareTriggerUnsubs: ReadonlyArray<() => void> = []

  constructor(ctx: DeviceContext) {
    super(ctx, hmUpdateSchema)
    this.registerUpdateCap()
    this.attachFirmwareRefresh()
  }

  private registerUpdateCap(): void {
    const provider: InferNativeProvider<typeof updateCapability> = {
      getStatus: async () => readUpdateStatus(this.resolveHmDevice()),
      installUpdate: async () => {
        await this.requireFacade().installFirmware(this.address)
      },
    }
    this.ctx.registerNativeCap(updateCapability, provider)
    // Seed the runtime-state slice so the device row + hero card (which subscribe
    // to `state.update`) render immediately, then keep it fresh on reconnect /
    // post-seed (see attachFirmwareRefresh).
    this.seedFirmwareSlice()
  }

  /** Write the live firmware descriptor into the `update` runtime-state slice. */
  private seedFirmwareSlice(): void {
    this.runtimeState.setCapState('update', readUpdateStatus(this.resolveHmDevice()))
  }

  /**
   * The CCU doesn't broadcast firmware-descriptor changes via `valueChanged`, so
   * re-read the descriptor into the slice whenever the library finishes initial
   * seeding (`ready`) or reconnects (`connection`) — mirrors how the channel-
   * bound children replay current values.
   */
  private attachFirmwareRefresh(): void {
    const facade = this.facade
    if (!facade) return
    this.firmwareTriggerUnsubs = [
      facade.on('ready', () => this.seedFirmwareSlice()),
      facade.on('connection', () => this.seedFirmwareSlice()),
    ]
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of this.firmwareTriggerUnsubs) {
      try {
        unsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
    }
    this.firmwareTriggerUnsubs = []
    await super.removeDevice()
  }
}
