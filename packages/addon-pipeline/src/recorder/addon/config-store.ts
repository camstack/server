/**
 * Per-device recording-config persistence for the recorder addon.
 *
 * A camera's config is its PER-DEVICE SETTINGS (D865), key `recordingConfig`,
 * through `ctx.settings.*DeviceStore`. Asking what camera 102 records is one
 * scope read; saving its config writes that key and touches no other camera.
 * Deleting the camera clears the scope centrally.
 *
 * ## What this replaced, and why
 *
 * Until the 2026-08-19 flatten every camera's `RecordingConfig` lived in ONE
 * key of the recorder's `addon-settings` / `root` blob — a row that was 201 833
 * bytes on the reference hub, because the ops-log and the export history shared
 * it. So `loadDeviceConfig(102)` read and `JSON.parse`d 201 KB, and
 * `saveDeviceConfig` read that, merged, and rewrote it. The staging walk did it
 * once per device and lost 45–267 s of a boot to it (2026-08-18); teaching the
 * walk to read the map once capped the symptom, and this removes the cause.
 *
 * ## Failure direction
 *
 * `RecordingConfigSchema` rejects unknown keys so a stale caller fails loudly,
 * but a row written by an older build may still carry retired ones — `.strip()`
 * drops them. And validation is now PER ROW: one unparseable camera costs that
 * camera, where the blob's single `safeParse` took every camera down to the
 * empty fallback (= the whole fleet silently unconfigured).
 */
import { z } from 'zod'
import {
  RecordingConfigSchema,
  deriveRecordingMode,
  migrateLegacyDeviceSignalConfig,
  stripRetiredBandPreBufferSec,
} from '@camstack/types'
import type {
  RecordingConfig,
  RecordingModeSource,
  RecordingStorageMode,
  IScopedLogger,
} from '@camstack/types'

/**
 * READ is forgiving where the wire contract is strict — see the header.
 * `.strip()` keeps a row written before a key was retired readable.
 *
 * The preprocess is the D371→D380 migration, applied on EVERY read so a row
 * behaves correctly from the first read of the boot, before
 * {@link migrateLegacyDeviceSignalRows} has persisted anything. Pure and
 * idempotent — a row with no legacy key passes through by reference.
 */
export const StoredRecordingConfigSchema = z
  .preprocess(
    (raw: unknown) => migrateLegacyDeviceSignalConfig(raw).value,
    RecordingConfigSchema.strip(),
  )
  // D381: the retired band `preBufferSec` is removed on READ, so a row written
  // before that record behaves like one written after it from the first read of
  // the boot — and so the key cannot reach `resolveBandBufferMs`, which no
  // longer has anywhere to put it. Pure and idempotent; a row without the key
  // passes through unchanged. `stripRetiredBandPreBufferSec` reports what it
  // removed for the callers that want to say so.
  .transform((config) => stripRetiredBandPreBufferSec(config).config)
export type StoredRecordingConfig = z.infer<typeof StoredRecordingConfigSchema>

/** The per-device settings key a camera's recording config lives under. */
export const RECORDING_CONFIG_KEY = 'recordingConfig'

/** The slice of `ctx.settings` the config store uses. */
export interface DeviceConfigSettings {
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  listDeviceStoreIds(): Promise<readonly number[]>
}

/**
 * Per-camera recording config over the STANDARD per-device settings (D865): the
 * one place device configuration lives, cleared for every addon when the device
 * is deleted. The surface is the six calls the recorder always made.
 *
 * ## No fallback to the old collection
 *
 * The retired `recorder:recording-configs` rows were moved by the one-shot D870
 * device-store migration on every operator hub (retired 2026-10-22). This code
 * reads and writes the per-device settings and nothing else.
 */
export interface RecordingConfigsState {
  declare(): Promise<void>
  read(key: string): Promise<StoredRecordingConfig | null>
  readAll(): Promise<Map<string, StoredRecordingConfig>>
  readAllRaw(): Promise<Map<string, unknown>>
  write(key: string, value: StoredRecordingConfig): Promise<void>
  remove(key: string): Promise<void>
}

export interface RecordingConfigsStateDeps {
  readonly settings: DeviceConfigSettings
  readonly logger: IScopedLogger
}

class DeviceSettingsConfigsState implements RecordingConfigsState {
  constructor(private readonly deps: RecordingConfigsStateDeps) {}

  async declare(): Promise<void> {}

  private parse(deviceId: number, raw: unknown): StoredRecordingConfig | null {
    const parsed = StoredRecordingConfigSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    this.deps.logger.warn('recording config row skipped — it does not parse', {
      tags: { deviceId },
      meta: { error: parsed.error.message },
    })
    return null
  }

  async read(key: string): Promise<StoredRecordingConfig | null> {
    const deviceId = Number(key)
    if (!Number.isInteger(deviceId)) return null
    const held = (await this.deps.settings.readDeviceStore(deviceId))[RECORDING_CONFIG_KEY]
    return held === undefined ? null : this.parse(deviceId, held)
  }

  async readAllRaw(): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>()
    const ids = await this.deps.settings.listDeviceStoreIds()
    const blobs = await this.deps.settings.readDeviceStoreBatch(ids)
    for (const [id, blob] of blobs) {
      const held = blob[RECORDING_CONFIG_KEY]
      if (held !== undefined) out.set(String(id), held)
    }
    return out
  }

  async readAll(): Promise<Map<string, StoredRecordingConfig>> {
    const out = new Map<string, StoredRecordingConfig>()
    for (const [key, raw] of await this.readAllRaw()) {
      const parsed = this.parse(Number(key), raw)
      if (parsed !== null) out.set(key, parsed)
    }
    return out
  }

  async write(key: string, value: StoredRecordingConfig): Promise<void> {
    const deviceId = Number(key)
    if (!Number.isInteger(deviceId)) throw new Error(`recording config: bad device id "${key}"`)
    await this.deps.settings.writeDeviceStore(deviceId, { [RECORDING_CONFIG_KEY]: value })
  }

  async remove(key: string): Promise<void> {
    const deviceId = Number(key)
    if (!Number.isInteger(deviceId)) return
    await this.deps.settings.writeDeviceStore(deviceId, { [RECORDING_CONFIG_KEY]: undefined })
  }
}

/** Build the handle over the standard per-device settings. */
export function recordingConfigsState(deps: RecordingConfigsStateDeps): RecordingConfigsState {
  return new DeviceSettingsConfigsState(deps)
}

/** Cold-start default for a camera that has never been configured: disabled, no bands. */
export const DEFAULT_DEVICE_CONFIG: RecordingConfig = { enabled: false, bands: [] }

/** The one logger method this store needs — narrow so no caller (or test) has
 *  to build a whole {@link IScopedLogger}. */
export type ConfigStoreLogger = Pick<IScopedLogger, 'warn'>

/** Read every persisted device config, keyed by numeric deviceId. */
export async function readDeviceConfigs(
  state: RecordingConfigsState,
): Promise<Map<number, RecordingConfig>> {
  const rows = await state.readAll()
  const map = new Map<number, RecordingConfig>()
  for (const [key, config] of rows) {
    const id = Number(key)
    if (Number.isInteger(id)) map.set(id, config)
  }
  return map
}

/**
 * The persisted config for a device — ONE keyed row read. `bands` is always
 * materialized (the schema defaults it to `[]`). An unconfigured device returns
 * {@link DEFAULT_DEVICE_CONFIG}.
 */
export async function loadDeviceConfig(
  state: RecordingConfigsState,
  deviceId: number,
): Promise<RecordingConfig> {
  return (await state.read(String(deviceId))) ?? DEFAULT_DEVICE_CONFIG
}

/**
 * The devices whose stored config claims to record (`enabled` + a non-`off`
 * derived `mode`) but has no band left — the one shape this store cannot
 * repair. It can only come from a pre-retirement config whose legacy authoring
 * fields were stripped on read: the camera records NOTHING until its bands are
 * re-authored, so the recorder shouts about it once at boot
 * ({@link warnLostBands}) instead of failing silently.
 */
export function deviceIdsWithLostBands(configs: ReadonlyMap<number, RecordingConfig>): number[] {
  const lost: number[] = []
  for (const [deviceId, config] of configs) {
    // `deviceDecision` is band-less BY DESIGN (D380) — the one config shape
    // that is enabled, records, and has no band. Reporting it as lost bands
    // would make the mode look like a corrupt row for ever.
    if (config.deviceDecision === true) continue
    if (config.enabled && config.bands.length === 0 && config.mode && config.mode !== 'off') {
      lost.push(deviceId)
    }
  }
  return lost.toSorted((a, b) => a - b)
}

/** Boot-time check: log the {@link deviceIdsWithLostBands} once, if any. */
export async function warnLostBands(
  state: RecordingConfigsState,
  logger: ConfigStoreLogger,
): Promise<void> {
  const lost = deviceIdsWithLostBands(await readDeviceConfigs(state))
  if (lost.length === 0) return
  logger.warn(
    `recording config: device(s) ${lost.join(', ')} claim a recording mode but have NO bands — ` +
      'a pre-retirement config that lost its legacy authoring fields. Nothing is recorded for ' +
      'them until their bands are re-authored.',
  )
}

/** What one boot run of {@link migrateLegacyDeviceSignalRows} changed. */
export interface LegacyDeviceSignalMigrationReport {
  /** Cameras whose config became `deviceDecision: true`. */
  readonly migrated: readonly number[]
  /** Cameras whose MIXED band merely lost the retired key — the band stays,
   *  and the camera no longer follows its own signal until an operator picks
   *  the new mode. */
  readonly stripped: readonly number[]
}

/**
 * Persist the D371→D380 shape for every stored row — the migration, in code,
 * run once per boot and IDEMPOTENT: a second run finds no legacy key and
 * writes nothing.
 *
 * It reads the rows RAW ({@link RowMapStore.readAllRaw}) on purpose. The read
 * schema already migrates in memory, so by the time `readAll` answers there is
 * nothing left to recognise — and the retired key is stripped by a non-strict
 * `z.object`, so the migration would look like it had nothing to do on exactly
 * the row it exists for.
 *
 * Both outcomes are logged, because both change what a camera records and
 * silence would read as "nothing happened" — which is what a stripped key
 * looks like from the outside.
 */
export async function migrateLegacyDeviceSignalRows(
  state: RecordingConfigsState,
  logger: ConfigStoreLogger & Pick<IScopedLogger, 'info'>,
): Promise<LegacyDeviceSignalMigrationReport> {
  const migrated: number[] = []
  const stripped: number[] = []
  for (const [key, raw] of await state.readAllRaw()) {
    const outcome = migrateLegacyDeviceSignalConfig(raw)
    if (!outcome.migrated && !outcome.strippedOnly) continue
    const deviceId = Number(key)
    if (!Number.isInteger(deviceId)) continue
    const parsed = RecordingConfigSchema.strip().safeParse(outcome.value)
    if (!parsed.success) {
      logger.warn('recording config: legacy device-signal row could not be migrated', {
        tags: { deviceId },
        meta: { error: parsed.error.message },
      })
      continue
    }
    await saveDeviceConfig(state, deviceId, parsed.data)
    if (outcome.migrated) migrated.push(deviceId)
    else stripped.push(deviceId)
  }
  if (migrated.length > 0) {
    logger.info(
      'recording config: migrated to the on-device-decision mode (the retired band trigger)',
      { meta: { deviceIds: migrated } },
    )
  }
  if (stripped.length > 0) {
    logger.warn(
      'recording config: a band mixed the retired device-signal trigger with others — the key was ' +
        'dropped and the band kept. These cameras no longer follow their own signal until the ' +
        'on-device-decision mode is selected for them.',
      { meta: { deviceIds: stripped } },
    )
  }
  return { migrated, stripped }
}

/**
 * Persist (insert or replace) a device's config — ONE row. Validates against
 * `RecordingConfigSchema` at the boundary (untrusted cap input). Returns the
 * validated config that was persisted.
 */
export async function saveDeviceConfig(
  state: RecordingConfigsState,
  deviceId: number,
  config: RecordingConfig,
): Promise<RecordingConfig> {
  const parsed = RecordingConfigSchema.parse(config)
  // `mode` is a DERIVED summary of the authoritative bands, persisted for the
  // cheap consumers that read one field (the viewer's status dot). A bands-only
  // write used to leave it absent — the dot then showed "online" for a camera
  // recording continuously (2026-07-30). Whatever `mode` the caller sent is
  // overwritten: bands are the only truth.
  const validated: RecordingConfig = {
    ...parsed,
    mode: parsed.enabled ? activeModeForConfig(parsed) : 'off',
  }
  await state.write(String(deviceId), validated)
  return validated
}

/**
 * The active recording mode for a config's bands — the value the `recording`
 * cap status reports. Thin alias over the canonical {@link deriveRecordingMode}
 * in `@camstack/types`, which the settings UI derives from too.
 */
export function activeModeForConfig(config: RecordingModeSource): RecordingStorageMode {
  return deriveRecordingMode(config)
}
