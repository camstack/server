/**
 * Display palette provider (D939, D940). The pipeline orchestrator owns
 * this cluster setting. The document is one key in the addon's store, so
 * a write does not replace the orchestrator's other settings. An
 * unreadable store is `unknown`, never the bundled preset.
 */
import {
  DISPLAY_PRESETS,
  PaletteRejectedError,
  bundledCamstack,
  paletteFromInput,
  paletteFromStored,
  storedFromReady,
  type AddonStoreRead,
  type IDisplayPaletteProvider,
  type IScopedLogger,
  type PaletteReady,
  type PaletteResult,
  type SetPaletteInput,
  type StoredKeyRead,
} from '@camstack/types'

/** Key inside the orchestrator's addon store. Not a settings-schema field. */
export const DISPLAY_PALETTE_STORE_KEY = 'displayPalette'

/** The settings reads and the write this provider uses. */
export interface DisplayPaletteSettings {
  readonly readAddonStoreResult?: () => Promise<AddonStoreRead>
  readonly readAddonStoreKeyResult?: (key: string) => Promise<StoredKeyRead>
  readonly writeAddonStore?: (patch: Record<string, unknown>) => Promise<unknown>
}

export function createDisplayPaletteProvider(
  settings: DisplayPaletteSettings | undefined,
  logger: IScopedLogger,
): IDisplayPaletteProvider {
  return {
    getPalette: async () => readPalette(settings, logger),
    listPresets: async () =>
      DISPLAY_PRESETS.map((row) => ({
        id: row.id,
        name: row.name,
        swatches: row.swatches,
        fallbacks: [...row.fallbacks],
      })),
    setPalette: async (input) => writePalette(settings, logger, input),
  }
}

async function readPalette(
  settings: DisplayPaletteSettings | undefined,
  logger: IScopedLogger,
): Promise<PaletteResult> {
  if (settings === undefined) {
    logger.warn('display-palette: settings store cannot be read three ways')
    return { status: 'unknown', reason: 'settings store cannot be read' }
  }
  const readKey = settings.readAddonStoreKeyResult
  if (readKey !== undefined) return readByKey(settings, readKey, logger)
  const read = settings.readAddonStoreResult
  if (read === undefined) {
    logger.warn('display-palette: settings store cannot be read three ways')
    return { status: 'unknown', reason: 'settings store cannot be read' }
  }
  return readByStore(settings, read, logger)
}

async function readByKey(
  settings: DisplayPaletteSettings,
  readKey: NonNullable<DisplayPaletteSettings['readAddonStoreKeyResult']>,
  logger: IScopedLogger,
): Promise<PaletteResult> {
  let result: StoredKeyRead
  try {
    result = await readKey.call(settings, DISPLAY_PALETTE_STORE_KEY)
  } catch (err: unknown) {
    return readThrew(logger, err)
  }
  if (result.kind === 'unreadable') {
    logger.warn('display-palette: settings unreadable', { meta: { error: result.error } })
    return { status: 'unknown', reason: result.error ?? 'settings store cannot be read' }
  }
  if (result.kind === 'absent') return bundledCamstack()
  return interpretStored(logger, result.value)
}

async function readByStore(
  settings: DisplayPaletteSettings,
  read: NonNullable<DisplayPaletteSettings['readAddonStoreResult']>,
  logger: IScopedLogger,
): Promise<PaletteResult> {
  let result: AddonStoreRead
  try {
    result = await read.call(settings)
  } catch (err: unknown) {
    return readThrew(logger, err)
  }
  if (result.kind === 'failed') {
    logger.warn('display-palette: settings unreadable', { meta: { error: result.error } })
    return { status: 'unknown', reason: result.error }
  }
  if (result.kind === 'missing') return bundledCamstack()
  return interpretStored(logger, result.value[DISPLAY_PALETTE_STORE_KEY])
}

function readThrew(logger: IScopedLogger, err: unknown): PaletteResult {
  const error = err instanceof Error ? err.message : String(err)
  logger.warn('display-palette: settings read threw', { meta: { error } })
  return { status: 'unknown', reason: 'settings store read failed' }
}

function interpretStored(logger: IScopedLogger, value: unknown): PaletteResult {
  const palette = paletteFromStored(value)
  if (palette.status === 'unknown') {
    logger.warn('display-palette: stored palette is not usable', {
      meta: { reason: palette.reason },
    })
  }
  return palette
}

async function writePalette(
  settings: DisplayPaletteSettings | undefined,
  logger: IScopedLogger,
  input: SetPaletteInput,
): Promise<PaletteReady> {
  let ready: PaletteReady
  try {
    ready = paletteFromInput(input)
  } catch (err: unknown) {
    if (err instanceof PaletteRejectedError) {
      logger.info('display-palette: refused', { meta: { reason: err.message } })
    }
    throw err
  }
  const write = settings?.writeAddonStore
  if (settings === undefined || write === undefined) {
    logger.warn('display-palette: settings store cannot be written')
    throw new Error('display-palette: settings store cannot be written')
  }
  const overrides = 'overrides' in input ? input.overrides : {}
  await write.call(settings, {
    [DISPLAY_PALETTE_STORE_KEY]: storedFromReady(ready, overrides),
  })
  return ready
}
