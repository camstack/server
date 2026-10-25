/**
 * Camera accessory orchestrator — given a camstack deviceId, builds one
 * HomeKit Accessory representing the camera (or doorbell) plus a
 * separate Accessory per child device (siren, floodlight, …).
 *
 * Flow:
 *  1. Resolve a typed `DeviceProxy` via `ctx.fetchDevice(deviceId)`.
 *  2. Inspect `proxy.binding.entries` (or fall back to `getDevice`
 *     features) to decide whether the device is a doorbell vs a
 *     regular camera. Doorbells get `Categories.VIDEO_DOORBELL` +
 *     `DoorbellController`; otherwise `Categories.IP_CAMERA` +
 *     `CameraController`.
 *  3. Build the streaming delegate via the `camera-streams` builder.
 *  4. `configureController(controller)` to attach the streaming
 *     services to the Accessory.
 *  5. Run each feature builder gated on cap presence (motion sensor,
 *     intercom, PTZ, doorbell).
 *  6. Enumerate children via `proxy.deviceManager.getChildren({...})`
 *     and build one Accessory per child (see `child-accessory.ts`).
 *  7. Return a `Mapper` whose `accessories[]` lists every accessory
 *     this device produced so the bridge can register them all and
 *     remove them all on unexpose.
 */
import {
  Accessory,
  CameraController,
  Categories,
  Characteristic,
  DoorbellController,
} from '@homebridge/hap-nodejs'

import type { AddonContext } from '@camstack/types'

import { populateAccessoryInfo } from './builders/accessory-info.js'
import { buildBattery } from './builders/battery.js'
import { buildCameraStreamingDelegate } from './builders/camera-streams.js'
import { buildDoorbell } from './builders/doorbell.js'
import { buildIntercom } from './builders/intercom.js'
import { buildMotionSensor } from './builders/motion-sensor.js'
import { buildPrivacySwitch } from './builders/privacy-switch.js'
import { buildPtz } from './builders/ptz.js'
import { probeAdvertisedVideoProfile } from './builders/stream-fps-probe.js'
import { buildHksvRecording } from '../hksv/build-recording.js'
import { buildChildServicesFor } from './child-accessory.js'
import { accessoryUuidFor } from './kind.js'
import {
  buildMultiTierServices,
  MULTI_TIER_RTP_SERVICE_UUID,
} from '../multi-tier/multi-tier-service.js'
import { buildMultiTierNegotiation } from '../multi-tier/negotiation.js'
import { tiersForSensor } from '../multi-tier/tiers-for-sensor.js'
import { TierVideoCodec } from '../multi-tier/video-stream-tiers.js'
import type { BuilderContext, BuilderHandle, CameraMapperOptions, Mapper } from './types.js'

export interface CameraAccessoryInput {
  readonly ctx: AddonContext
  readonly deviceId: string
  readonly displayName: string
  readonly options: CameraMapperOptions
}

export async function buildCameraAccessory(input: CameraAccessoryInput): Promise<Mapper> {
  const { ctx, deviceId, displayName, options } = input
  const numericId = Number.parseInt(deviceId, 10)
  if (!Number.isFinite(numericId)) {
    throw new Error(`export-hap: cannot map device '${deviceId}' — id is not numeric`)
  }

  const proxy = await ctx.fetchDevice(numericId)
  const capNames = new Set(proxy.binding?.entries.map((e) => e.capName) ?? [])

  // Doorbell vs camera category selection.
  const isDoorbell = capNames.has('doorbell')
  const category = isDoorbell ? Categories.VIDEO_DOORBELL : Categories.IP_CAMERA
  const accessoryUuid = accessoryUuidFor('camera', numericId)
  const accessory = new Accessory(displayName, accessoryUuid)
  accessory.category = category

  await populateAccessoryInfo(accessory, proxy, displayName, 'Camera')

  const bctx: BuilderContext = {
    ctx,
    accessory,
    proxy,
    numericDeviceId: numericId,
    displayName,
    options,
  }

  // Probe the per-profile frame rates BEFORE building the delegate: HAP
  // freezes `SupportedVideoStreamConfiguration` when the controller is
  // constructed, so this is the only moment the advertisement can be honest.
  // See `builders/stream-fps.ts` (R2).
  const advertisedVideo = await probeAdvertisedVideoProfile(bctx)

  // Build streaming delegate + options. The intercom builder mutates
  // `streamingOptions.audio.twoWayAudio` BEFORE we hand the options to
  // the controller — order matters.
  const streams = buildCameraStreamingDelegate(bctx, advertisedVideo)
  const handles: BuilderHandle[] = []

  if (capNames.has('intercom')) {
    handles.push(await buildIntercom({ bctx, streamingOptions: streams.streamingOptions }))
  }

  // ── HomeKit Secure Video ────────────────────────────────────────────
  //
  // `recording` is OPTIONAL in `CameraControllerOptions`, and passing it IS the
  // entire user-visible change: with it, iOS offers "Stream and Allow
  // Recording"; without it the `CameraRecordingManagement` and
  // `CameraOperatingMode` services are not on the accessory at all.
  //
  // It used to be passed with a STUB delegate whose
  // `handleRecordingStreamRequest` was a `require-yield` generator — it
  // returned without ever yielding a `RecordingPacket`, so it never set
  // `isLast`, and hap-nodejs answered every request with
  // `Delegate finished streaming for N without setting RecordingPacket.isLast`
  // followed by a ~12 s timeout, all day, on every motion-capable camera
  // (D50). It was then withdrawn entirely, because the contract cannot be
  // satisfied without a live fMP4 fragment source and CamStack had none.
  //
  // It now has one (D80, D84), so the advertisement and the delegate come back
  // TOGETHER — `buildHksvRecording` returns both or neither, and returns
  // `null`, with a reason in the log, for every camera it cannot serve.
  //
  // Do NOT re-add a stub, and never advertise `recording` from anywhere but
  // this call.
  // Advertised whenever the camera CAN be recorded — never gated on a
  // preference of ours.
  //
  // There used to be a per-camera switch here deciding whether to OFFER
  // recording. It was a second authority over a function HomeKit already owns:
  // iOS asks "Stream" or "Stream and Allow Recording" and persists that answer
  // on the accessory itself, and the prebuffer only ever runs when that
  // characteristic is active. Ours could disagree with it, and did — the day
  // its default was flipped, 101 kept teeing clips from an accessory built
  // under the old default while every surface reported no HomeKit source
  // (D589, and D62 for the rule it broke).
  //
  // What remains is a CAPABILITY gate: `buildHksvRecording` returns null, with
  // a reason, for a camera it cannot serve. Offering a toggle backed by
  // nothing is the one thing worse than not offering it.
  let recordingAudioActive = true
  const recording = await buildHksvRecording({
    bctx,
    fpsByProfile: advertisedVideo.fpsByProfile,
    // Read through a closure rather than captured: the characteristic is
    // hap-nodejs's, it is persisted across reboots, and a second copy of it
    // here would be a knob that disagrees with the one iOS writes (D62).
    isAudioActive: () => recordingAudioActive,
  })

  const Controller = isDoorbell ? DoorbellController : CameraController
  const controller = new Controller({
    delegate: streams.delegate,
    streamingOptions: streams.streamingOptions,
    cameraStreamCount: 2,
    ...(recording === null ? {} : { recording }),
    // HKSV derives its MOTION event trigger from the controller's OWN motion
    // service; a MotionSensor added beside the controller is invisible to it.
    // So when recording is on the controller creates the service and the motion
    // builder adopts it. This is a STRUCTURAL change to the accessory (it bumps
    // `c#`), which is why turning the setting on rebuilds the accessory.
    ...(recording === null || !capNames.has('motion-detection')
      ? {}
      : { sensors: { motion: true } }),
  })
  accessory.configureController(controller)

  // Apple's new camera specification, declared as a whole or not at all.
  //
  // Three services, because none of them means anything alone: § 4.5 makes
  // `Camera Capabilities` the thing that SAYS the accessory speaks this
  // specification, and `Status Active` on the streaming service is defined in
  // terms of the global operating mode's switches. The first cut declared the
  // streaming service by itself and iOS read its tiers and opened the session
  // on the classic service two seconds later — it had never been told what the
  // tiers belonged to.
  //
  // Added AFTER the controller so they cannot disturb the services it owns.
  // Nothing streams yet: `canServeStream` is false, which makes `Status Active`
  // false, which is the state § 3.6 defines for a camera that is not streaming
  // and the reason a Start is refused in the specification's own words.
  if (options.hapDeviceSettings.multiTierService !== false) {
    // The SENSOR, not the advertised resolution list. That list belongs to the
    // classic service and is capped at 1080p; the kitchen camera's main stream
    // is 3840x2160 H.265, and the 4K is the whole reason this service exists.
    const sensor = advertisedVideo.sensor
    const services = buildMultiTierServices({
      deviceId: numericId,
      logger: ctx.logger,
      width: sensor.width,
      height: sensor.height,
      codec: sensor.codec,
      // 16 kHz is the guide's mandatory capture rate and what this fleet's
      // cameras publish; what goes on the wire is 48 kHz either way.
      audioCaptureRateHz: 16000,
      // The adapter drives the SAME engine the classic service uses --
      // hap-nodejs's own handlers are private, so the library's engine cannot
      // be borrowed, but ours can, and a second copy would be two engines to
      // keep in agreement. Its presence is also what makes `Status Active`
      // true: one fact, one place.
      negotiation: buildMultiTierNegotiation({
        deviceId: numericId,
        logger: ctx.logger,
        negotiator: streams.negotiator,
        tiers: tiersForSensor(sensor.width, sensor.height),
        codec: sensor.codec,
      }),
    })
    accessory.addService(services.capabilities)
    accessory.addService(services.globalOperatingMode)
    accessory.addService(services.streamManagement)
    ctx.logger.info('hap multi-tier: services declared on this accessory', {
      tags: { deviceId: numericId },
      meta: {
        serviceUuid: MULTI_TIER_RTP_SERVICE_UUID,
        codec: sensor.codec === TierVideoCodec.H265 ? 'h265' : 'h264',
        sensor: `${sensor.width}x${sensor.height}`,
      },
    })
  }

  if (recording !== null) {
    handles.push({ dispose: () => recording.dispose() })
    // `RecordingAudioActive` lives on the controller's CameraOperatingMode
    // service and only exists once the controller is configured. HAP is
    // explicit that fragments MUST NOT carry audio when it is false, and an
    // fMP4 fragment has no second plane to strip it on — so the source
    // respawns onto the muted url. Seeded from the persisted value, then kept
    // in step by the characteristic's own change event.
    const operatingMode = controller.recordingManagement?.operatingModeService
    const audioCharacteristic = operatingMode?.getCharacteristic(
      Characteristic.RecordingAudioActive,
    )
    if (audioCharacteristic) {
      recordingAudioActive = audioCharacteristic.value !== 0 && audioCharacteristic.value !== false
      audioCharacteristic.on('change', ({ newValue }) => {
        recordingAudioActive = newValue !== 0 && newValue !== false
      })
    }
  }

  // Feature builders gated on capability presence.
  if (capNames.has('motion-detection')) {
    handles.push(
      await buildMotionSensor(bctx, recording === null ? null : (controller.motionService ?? null)),
    )
  }
  if (isDoorbell && controller instanceof DoorbellController) {
    handles.push(await buildDoorbell({ bctx, controller }))
  }
  if (capNames.has('ptz') || capNames.has('ptz-autotrack')) {
    handles.push(await buildPtz(bctx))
  }
  if (capNames.has('battery')) {
    handles.push(await buildBattery(bctx))
  }
  if (capNames.has('privacy-mask')) {
    handles.push(await buildPrivacySwitch(bctx))
  }

  // Accessory children (siren / floodlight / spotlight / …) used to
  // be published as INDEPENDENT standalone Accessories — that meant
  // one mDNS service + one HAP port per child and an iOS Home tile
  // per child. Round 3 collapses them into Services ON the parent
  // camera Accessory so iOS Home renders the camera as a single tile
  // with the siren/floodlight as inline controls.
  handles.push(await buildChildServicesFor({ parentCtx: bctx }))

  return {
    accessory,
    accessories: [accessory],
    async dispose(): Promise<void> {
      const log = ctx.logger.withTags({ deviceId: numericId })
      for (const h of handles) {
        try {
          await h.dispose()
        } catch (err) {
          log.debug('export-hap: builder dispose failed (continuing)', {
            meta: { error: errMsg(err) },
          })
        }
      }
      try {
        await streams.dispose()
      } catch (err) {
        log.debug('export-hap: streams dispose failed', {
          meta: { error: errMsg(err) },
        })
      }
    },
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
