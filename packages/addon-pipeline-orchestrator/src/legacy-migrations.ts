/**
 * One-shot legacy-flags → binding migrations for the pipeline orchestrator.
 *
 * Extracted verbatim from `index.ts`'s `migrateLegacyFlagsToBindings`
 * (S1 refactor slice — zero behavior change), as a free function over an
 * injected-deps object so it no longer needs the full addon instance.
 */
import type {
  AddonApi,
  AddonContext,
  CameraPipelineSettings,
  DurableState,
  IScopedLogger,
} from '@camstack/types'

/** Injected dependencies for `migrateLegacyFlagsToBindings`. */
export interface LegacyMigrationDeps {
  /**
   * Live api accessor — polled (not read once) because `ctx.api` may not be
   * wired yet when this migration kicks off during `onInitialize`.
   */
  readonly api: () => AddonApi | null
  readonly settings: AddonContext['settings']
  /** Reads the `cameraSettings` durable map (keyed on deviceId as string). */
  readonly cameraSettingsStore: () => Promise<Record<string, CameraPipelineSettings>>
  /**
   * One-shot guard flag. Absent or corrupt ⇒ `false` (the migration runs —
   * same fallback as the old raw `store[key] === true` check).
   */
  readonly doneFlag: DurableState<boolean>
  readonly logger: IScopedLogger
}

/**
 * Migrates legacy `audioEnabled` / `pipelineEnabled` / `motionDetectionEnabled`
 * / `disableInference` boolean flags (formerly read ad hoc from the per-device
 * settings store) to the binding-driven wrapper-active model
 * (`deviceManager.setWrapperActive`). Runs once, guarded by `deps.doneFlag`;
 * failure re-arms on next boot since the flag is only persisted after a
 * successful pass.
 *
 * `deps.api` is polled for up to ~6s because the hub's bootstrap wires
 * `ctx.api` after the addon init chain resolves, so it may not be ready the
 * instant this migration is kicked off from `onInitialize`.
 */
export async function migrateLegacyFlagsToBindings(deps: LegacyMigrationDeps): Promise<void> {
  const { api: getApi, settings, cameraSettingsStore, doneFlag, logger } = deps

  if (await doneFlag.get()) return

  // Poll up to ~6s for ctx.api to become available; the hub's bootstrap
  // wires it after the addon init chain resolves.
  let api = getApi()
  for (let i = 0; !api && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200))
    api = getApi()
  }
  if (!api) {
    logger.warn('bindings migration skipped — ctx.api not available')
    return
  }

  const devices = await api.deviceManager.listAll.query({}).catch(() => [])
  const cameras = devices.filter((d) => d.type === 'camera')

  let audioDisabled = 0
  let detectionDisabled = 0
  let motionDisabled = 0
  for (const device of cameras) {
    const raw = (await settings?.readDeviceStore(device.id)) ?? {}
    if (raw['audioEnabled'] === false) {
      await api.deviceManager.setWrapperActive.mutate({
        deviceId: device.id,
        capName: 'audio-analysis',
        wrapperAddonId: 'audio-analyzer',
        active: false,
      })
      audioDisabled++
    }
    if (raw['pipelineEnabled'] === false) {
      await api.deviceManager.setWrapperActive.mutate({
        deviceId: device.id,
        capName: 'detection-pipeline',
        wrapperAddonId: 'detection-pipeline',
        active: false,
      })
      detectionDisabled++
    }
    // F15a: legacy `motionDetectionEnabled:false` → motion-detection
    // wrapper off. The wrapper addon id depends on which motion addon
    // was registered; `motion-wasm` is the in-tree default and matches
    // F9's manifest declaration.
    if (raw['motionDetectionEnabled'] === false) {
      await api.deviceManager.setWrapperActive.mutate({
        deviceId: device.id,
        capName: 'motion-detection',
        wrapperAddonId: 'motion-wasm',
        active: false,
      })
      motionDisabled++
    }
  }

  // disableInference lived in the cameraSettings map (separate from the
  // per-device orchestrator store). Mirror the same migration there.
  const cameraSettings = await cameraSettingsStore()
  for (const [rawKey, cam] of Object.entries(cameraSettings)) {
    const camObj = cam as Record<string, unknown> | undefined
    if (camObj?.['disableInference'] === true) {
      const deviceId = Number(rawKey)
      if (!Number.isFinite(deviceId) || !Number.isInteger(deviceId)) continue
      await api.deviceManager.setWrapperActive.mutate({
        deviceId,
        capName: 'detection-pipeline',
        wrapperAddonId: 'detection-pipeline',
        active: false,
      })
      detectionDisabled++
    }
  }

  await doneFlag.set(true)
  logger.info('bindings migration complete', {
    meta: {
      cameras: cameras.length,
      audioDisabled,
      detectionDisabled,
      motionDisabled,
    },
  })
}
