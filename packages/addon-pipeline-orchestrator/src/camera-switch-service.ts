/**
 * `CameraSwitchService` — a DEPRECATED compatibility shim
 * ([D113](../../../docs/decisions/adr-0113.md)).
 *
 * ## What this is now
 *
 * The per-camera function switch GROUP (D62) is being withdrawn. The operator's
 * verdict on 2026-08-12 was that a second, aggregate place to turn a function
 * off bought complexity and no clarity — every one of these already has a
 * settings page of its own, and each is going back to it. Detection is the
 * detection-pipeline wrapper binding; audio analysis is its own; recording is
 * `RecordingConfig.enabled`, which was always first-class and over which this
 * group was only ever a veneer.
 *
 * It cannot be deleted TODAY: shipped viewers (v1.0.305) still call
 * `pipelineOrchestrator.getCameraSwitches` / `setCameraSwitch`, and removing
 * the pair would break an app nobody can redeploy from here. So the pair stays
 * and KEEPS WORKING, served by this shim, until the last caller is gone.
 *
 * **Phase 3 is complete as of 2026-08-13** — every one of the eight functions
 * now has a surface that writes its own authority, so no admin surface calls
 * this shim any more. Two rows had NO other writer before that
 * (`device-audio`, `broker-audio`), which is why deleting the pair earlier
 * would have made them unreachable rather than merely inconvenient;
 * `scripts/check-switch-successor-surfaces.ts` now enforces that ordering.
 * What still blocks phase 4: shipped viewers, and
 * `addon-provider-homeassistant`'s `ha-export`, which projects the whole group
 * as HA switch entities and commands them back through `setCameraSwitch`.
 *
 * ## It owns nothing, derives nothing of its own
 *
 * Read: `readSwitchAuthorities` (`switch-authorities.ts`) — the same one bounded
 * pass `CameraStatusService` uses for `CameraStatus.switchedOff` — then the
 * pure `deriveCameraSwitches` for the labels and cost lines the group's UI
 * renders. Write: `applyWrite`, straight to the authority the read came from.
 *
 * That sharing is the point. While two surfaces exist they must not be able to
 * disagree, and the only way to guarantee that is one read path. The status
 * badge no longer goes through this class at all — it composes from the
 * authorities directly, so this file can be deleted without touching it.
 *
 * | Function | Read (in `switch-authorities.ts`) | Write (here) |
 * | --- | --- | --- |
 * | `stream-broker` | `deviceManager.getDevice().disabled` | `deviceManager.setDisabled` |
 * | `object-detection` | `getBindings` ∋ `detection-pipeline` | `setWrapperActive` |
 * | `audio-analysis` | `getBindings` ∋ `audio-analysis` | `setWrapperActive` |
 * | `recording` | `recordingArchive.getDeviceConfig().enabled` | `recordingArchive.setDeviceConfig` (`enabled` ONLY) |
 * | `notifications` | `notificationRules.listDeviceMutes` | `notificationRules.setDeviceMuted` |
 * | `privacy-mask` | `privacyMask.getOptions` + `getStatus` | `privacyMask.setMask({ enabled })` |
 * | `device-audio` | `privacyMask.getOptions` + `getStatus` | `privacyMask.setAudioEnabled` |
 * | `broker-audio` | `streamBroker.getDeviceAudioMute` | `streamBroker.setDeviceAudioMute` |
 *
 * ## Three rules the tests pin
 *
 * - **A source that did not answer is `available: false`**, never a control
 *   defaulted to "on".
 * - **A write to an unavailable switch is REFUSED**, loudly. Persisting one
 *   would be a write nothing reads.
 * - **Recording flips `enabled` and nothing else.** `bands` is the only authored
 *   intent and `mode` is derived from it; clearing bands to express "off"
 *   destroys the operator's schedule and turning the camera back on would then
 *   silently record nothing.
 */
import type {
  AddonApi,
  CameraSwitch,
  CameraSwitchAuthority,
  CameraSwitchGroup,
  CameraSwitchId,
  IScopedLogger,
} from '@camstack/types'
import { CAMERA_SWITCH_CATALOG, deriveCameraSwitches, nodePin } from '@camstack/types'
import type { RepeatWarnSampler } from './repeat-warn-sampler.js'
import { readSwitchAuthorities, type SwitchAuthorityReads } from './switch-authorities.js'

export interface CameraSwitchServiceDeps {
  /** Live api accessor — `null` before the hub wires `ctx.api`. */
  readonly api: () => AddonApi | null
  readonly logger: IScopedLogger
  /**
   * `topology.assignSource(deviceId)` — the node whose stream-broker holds this
   * camera's brokers. Only `broker-audio` needs it; see
   * `switch-authorities.ts`.
   */
  readonly assignSource: (deviceId: number) => string
  /** The shared per-`(camera, source)` fault sampler; see `switch-authorities.ts`. */
  readonly warnSampler: RepeatWarnSampler
}

export class CameraSwitchService {
  constructor(private readonly deps: CameraSwitchServiceDeps) {}

  /** The whole group for one camera, derived from the authorities. */
  async getCameraSwitches(deviceId: number): Promise<CameraSwitchGroup> {
    const { derivation } = await this.read(deviceId)
    return {
      deviceId,
      switches: deriveCameraSwitches(derivation),
      fetchedAt: Date.now(),
    }
  }

  /**
   * Flip one switch and return the RECOMPOSED group, so a client renders what
   * the server settled on rather than its own optimistic guess.
   */
  async setCameraSwitch(
    deviceId: number,
    switchId: CameraSwitchId,
    enabled: boolean,
  ): Promise<CameraSwitchGroup> {
    const api = this.deps.api()
    if (!api) throw new Error('camera switches unavailable — the hub api is not wired yet')

    const state = await this.read(deviceId)
    const current = deriveCameraSwitches(state.derivation).find((s) => s.id === switchId)
    if (!current) throw new Error(`unknown camera switch '${switchId}'`)
    if (!current.available) {
      // Refused, not persisted. A write nothing reads is the failure mode this
      // whole surface was built to remove.
      this.deps.logger.warn('camera switch write REFUSED — the switch is not available here', {
        tags: { deviceId },
        meta: { switchId, reason: current.unavailableReason },
      })
      throw new Error(
        `camera switch '${switchId}' is not available for device ${deviceId} (${current.unavailableReason})`,
      )
    }

    await this.applyWrite(api, deviceId, current, state, enabled)

    this.deps.logger.info('camera switch changed', {
      tags: { deviceId },
      meta: { switchId, enabled, authority: current.authority.kind },
    })

    return this.getCameraSwitches(deviceId)
  }

  private read(deviceId: number): Promise<SwitchAuthorityReads> {
    return readSwitchAuthorities(this.deps.api(), deviceId, {
      logger: this.deps.logger,
      assignSource: this.deps.assignSource,
      warnSampler: this.deps.warnSampler,
    })
  }

  // ── write routing ─────────────────────────────────────────────────

  private async applyWrite(
    api: AddonApi,
    deviceId: number,
    current: CameraSwitch,
    state: SwitchAuthorityReads,
    enabled: boolean,
  ): Promise<void> {
    const authority: CameraSwitchAuthority = current.authority
    switch (authority.kind) {
      case 'device-disabled':
        await api.deviceManager.setDisabled.mutate({ deviceId, disabled: !enabled })
        return
      case 'wrapper-binding': {
        const wrapperAddonId = state.wrapperAddonIdByCap.get(authority.capName)
        if (wrapperAddonId === undefined)
          throw new Error(
            `no wrapper registered for '${authority.capName}' — nothing could apply this switch`,
          )
        await api.deviceManager.setWrapperActive.mutate({
          deviceId,
          capName: authority.capName,
          wrapperAddonId,
          active: enabled,
        })
        return
      }
      case 'recording-config': {
        const config = state.recordingConfig
        if (config === null)
          throw new Error(`recording config unreadable for device ${deviceId} — refusing to write`)
        // `enabled` ONLY. `bands` carries the operator's authored schedule and
        // `mode` is derived from it by the recorder on save — neither is ours
        // to touch.
        await api.recordingArchive.setDeviceConfig.mutate({
          deviceId,
          config: { ...config, enabled },
        })
        return
      }
      case 'notification-mute':
        await api.notificationRules.setDeviceMuted.mutate({ deviceId, muted: !enabled })
        return
      case 'camera-audio':
        // The write goes to the CAMERA, and nothing is cached here. The
        // provider's `setAudioEnabled` reads the camera back into its own
        // runtime-state slice, which IS the read side — so the next status read
        // sees the new value with nothing on this side to invalidate (D221).
        await api.privacyMask.setAudioEnabled.mutate({ deviceId, enabled })
        return
      case 'camera-mask':
        // `enabled` ONLY — `regions` carries the operator's drawing and is not
        // ours to touch, exactly as `bands` is not on `recording-config`.
        await api.privacyMask.setMask.mutate({ deviceId, patch: { enabled } })
        return
      case 'broker-audio-mute':
        // Node-pinned: the brokers live on the camera's source owner. The store
        // is the broker's own `DeviceOverride` blob. Polarity inverts: the
        // switch is "audio is distributed", the fact is "muted".
        await api.streamBroker.setDeviceAudioMute.mutate(
          { deviceId, muted: !enabled },
          nodePin(this.deps.assignSource(deviceId)),
        )
        return
    }
  }
}

/** Re-exported so a caller can render a cost line without a second import. */
export { CAMERA_SWITCH_CATALOG }
