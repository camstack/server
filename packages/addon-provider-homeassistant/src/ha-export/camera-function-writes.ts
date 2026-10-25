/**
 * Performs the WRITE of a camera function on the authority that owns it.
 *
 * `deriveCameraFunctions`/`resolveCameraFunctionWrite` (`camera-functions.ts`)
 * decide; this module acts. It is the file that
 * `scripts/check-switch-successor-surfaces.ts` points to as the successor of the
 * deprecated pair `getCameraSwitches` / `setCameraSwitch` (D113 phase 4).
 */
import { nodePin } from '@camstack/types'
import type { CameraFunctionWrite } from './camera-functions.js'

/** The slice of `ctx.api` that this write uses. Injected, so it is testable. */
export interface CameraFunctionWriteApi {
  readonly deviceManager: {
    readonly setDisabled: {
      mutate(input: { deviceId: number; disabled: boolean }): Promise<unknown>
    }
    readonly setWrapperActive: {
      mutate(input: {
        deviceId: number
        capName: string
        wrapperAddonId: string
        active: boolean
      }): Promise<unknown>
    }
  }
  /** The D62 recording authority, which stayed a system SINGLETON when
   *  `recording` became a device collection (D625) — one reader and one
   *  writer, so an HA switch cannot disagree with the admin UI. */
  readonly recordingArchive: {
    readonly getDeviceConfig: { query(input: { deviceId: number }): Promise<RecordingConfigShape> }
    readonly setDeviceConfig: {
      mutate(input: { deviceId: number; config: RecordingConfigShape }): Promise<unknown>
    }
  }
  readonly notificationRules: {
    readonly setDeviceMuted: {
      mutate(input: { deviceId: number; muted: boolean }): Promise<unknown>
    }
  }
  readonly privacyMask: {
    readonly setMask: {
      mutate(input: { deviceId: number; patch: { enabled: boolean } }): Promise<unknown>
    }
    readonly setAudioEnabled: {
      mutate(input: { deviceId: number; enabled: boolean }): Promise<unknown>
    }
  }
  readonly streamBroker: {
    readonly setDeviceAudioMute: {
      mutate(input: { deviceId: number; muted: boolean }, opts?: unknown): Promise<unknown>
    }
  }
}

/** Opaque on purpose: here we read and rewrite, we do not interpret. */
export type RecordingConfigShape = Readonly<Record<string, unknown>> & { readonly enabled: boolean }

export async function applyCameraFunctionWrite(
  api: CameraFunctionWriteApi,
  deviceId: number,
  write: CameraFunctionWrite,
  sourceNodeId: string | null,
): Promise<void> {
  switch (write.kind) {
    case 'device-disabled':
      await api.deviceManager.setDisabled.mutate({ deviceId, disabled: write.disabled })
      return
    case 'wrapper-binding':
      await api.deviceManager.setWrapperActive.mutate({
        deviceId,
        capName: write.capName,
        wrapperAddonId: write.wrapperAddonId,
        active: write.active,
      })
      return
    case 'recording-enabled': {
      // Re-read and resend: `bands` belongs to the operator, `mode` derives from it.
      const config = await api.recordingArchive.getDeviceConfig.query({ deviceId })
      await api.recordingArchive.setDeviceConfig.mutate({
        deviceId,
        config: { ...config, enabled: write.enabled },
      })
      return
    }
    case 'notification-mute':
      await api.notificationRules.setDeviceMuted.mutate({ deviceId, muted: write.muted })
      return
    case 'camera-mask':
      // `enabled` and nothing else: `regions` is the operator's drawing.
      await api.privacyMask.setMask.mutate({ deviceId, patch: { enabled: write.enabled } })
      return
    case 'camera-audio':
      await api.privacyMask.setAudioEnabled.mutate({ deviceId, enabled: write.enabled })
      return
    case 'broker-audio-mute':
      if (sourceNodeId === null) {
        throw new Error(
          `refusing an unrouted broker audio write for device ${String(deviceId)}: no source node`,
        )
      }
      await api.streamBroker.setDeviceAudioMute.mutate(
        { deviceId, muted: write.muted },
        nodePin(sourceNodeId),
      )
      return
  }
}
