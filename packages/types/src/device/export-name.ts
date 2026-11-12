/**
 * The exposed name of a device on one export instance (`device-export`, D1049).
 *
 * Every exporter keeps its names the same way: in ITS per-device store (D865), under
 * {@link EXPOSED_NAMES_STORE_KEY}, one entry per instance id. The store is cleared centrally
 * when the device is deleted, so no removal hook is needed for it. Each exporter supplies the
 * validator of its own platform; the normalisation, the store shape and the refusal are here so
 * the four exporters cannot drift apart.
 *
 * The name is a label only: no exporter derives the exported id from it, so a rename updates
 * the same device on the platform.
 */
import { z } from 'zod'
import { ExportNameRefusedError } from '../capabilities/device-export.cap.js'

/** The per-device store key holding `{ [instanceId]: name }`. */
export const EXPOSED_NAMES_STORE_KEY = 'exposedNames'

const ExposedNamesSchema = z.record(z.string(), z.string())

export type ExposedNameCheck =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly reason: string }

/** A platform's naming rule over a normalised, non-blank name. */
export type ExposedNameValidator = (name: string) => ExposedNameCheck

/** A per-device store, as the exporter reaches it (`ctx.settings.readDeviceStore` / `writeDeviceStore`). */
export interface ExposedNameStore {
  read(deviceId: number): Promise<Readonly<Record<string, unknown>>>
  write(deviceId: number, patch: Record<string, unknown>): Promise<void>
}

export interface SaveExposedNameInput {
  readonly store: ExposedNameStore
  readonly deviceId: number
  readonly instanceId: string
  readonly raw: unknown
  readonly validate: ExposedNameValidator
}

export interface SaveExposedNameResult {
  readonly changed: boolean
  readonly name: string | null
}

/** Trim and collapse whitespace, then the platform rule. Blank or null clears (`name: null`). */
export function checkExposedName(raw: unknown, validate: ExposedNameValidator): ExposedNameCheck {
  if (raw === null || raw === undefined) return { ok: true, name: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'The name must be text.' }
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length === 0) return { ok: true, name: null }
  return validate(name)
}

/** Every saved name of a device, by instance id. A malformed blob reads as none. */
export function readExposedNames(
  store: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const parsed = ExposedNamesSchema.safeParse(store[EXPOSED_NAMES_STORE_KEY])
  return parsed.success ? parsed.data : {}
}

/**
 * The saved name of one instance, or null: never saved, or a stored value the platform would
 * now refuse (the device's own name is used rather than pushing a name the platform rejects).
 */
export function readExposedName(
  store: Readonly<Record<string, unknown>>,
  instanceId: string,
  validate: ExposedNameValidator,
): string | null {
  const saved = readExposedNames(store)[instanceId]
  if (saved === undefined) return null
  const check = checkExposedName(saved, validate)
  return check.ok ? check.name : null
}

/** The store patch that sets (or, with null, clears) one instance's name and keeps the others. */
export function exposedNamePatch(
  store: Readonly<Record<string, unknown>>,
  instanceId: string,
  name: string | null,
): Record<string, unknown> {
  const others = Object.fromEntries(
    Object.entries(readExposedNames(store)).filter(([id]) => id !== instanceId),
  )
  return {
    [EXPOSED_NAMES_STORE_KEY]: name === null ? others : { ...others, [instanceId]: name },
  }
}

/**
 * Validate and save one instance's name. A name the platform would refuse throws
 * {@link ExportNameRefusedError} BEFORE anything is written, so the old name stays.
 */
export async function saveExposedName(input: SaveExposedNameInput): Promise<SaveExposedNameResult> {
  const check = checkExposedName(input.raw, input.validate)
  if (!check.ok) throw new ExportNameRefusedError(input.instanceId, check.reason)
  const store = await input.store.read(input.deviceId)
  const before = readExposedNames(store)[input.instanceId] ?? null
  if (before === check.name) return { changed: false, name: check.name }
  await input.store.write(input.deviceId, exposedNamePatch(store, input.instanceId, check.name))
  return { changed: true, name: check.name }
}

/** The part of `ctx.settings` an exporter's names live in (D865). */
export interface DeviceStoreAccess {
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
}

/** The exporter's per-device store as an {@link ExposedNameStore}; throws when settings are absent. */
export function exposedNameStoreOf(
  settings: DeviceStoreAccess | undefined,
  owner: string,
): ExposedNameStore {
  const access = (): DeviceStoreAccess => {
    if (settings === undefined) throw new Error(`${owner}: settings are not available`)
    return settings
  }
  return {
    read: (deviceId) => access().readDeviceStore(deviceId),
    write: (deviceId, patch) => access().writeDeviceStore(deviceId, patch),
  }
}

/** No control characters, at most `max` characters: the rule of a platform that takes free text. */
export function freeTextNameValidator(platform: string, max: number): ExposedNameValidator {
  return (name) => {
    if (name.length > max) {
      return {
        ok: false,
        reason: `The name is ${name.length} characters; ${platform} allows at most ${max}.`,
      }
    }
    if (/\p{Cc}/u.test(name)) {
      return {
        ok: false,
        reason: `The name may not contain control characters.`,
      }
    }
    return { ok: true, name }
  }
}
