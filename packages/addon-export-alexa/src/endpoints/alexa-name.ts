/**
 * The per-device "Alexa name" (D875): what Alexa calls the device, when it
 * should not be the device's own name.
 *
 * Stored under {@link ALEXA_NAME_KEY} in this addon's per-device settings store
 * (D870) and used as the endpoint `friendlyName`. It never reaches the endpoint
 * id (`<deviceId>__dev`), so renaming updates the SAME Alexa device on the next
 * AddOrUpdateReport instead of creating a duplicate.
 *
 * Amazon's friendlyName rule (Alexa.Discovery objects, endpoint object): "Up
 * to 256 alphanumeric characters and spaces. Don't include special characters
 * or punctuation." Letters of any script count as alphanumeric, so an Italian
 * name keeps its accents. The validator rejects what Amazon would reject, with
 * a message the operator can act on.
 */
import { z } from 'zod'

/** Per-device store key of the saved Alexa name. */
export const ALEXA_NAME_KEY = 'alexaName'

/** The device-settings form field key, namespaced per exporter (see the addon). */
export function alexaNameKey(deviceId: number): string {
  return `alexa:${deviceId}:alexaName`
}

export const ALEXA_NAME_MAX_LENGTH = 256

/** Letters (any script, with their combining marks), digits and spaces. */
const ALLOWED_PATTERN = /^[\p{L}\p{M}\p{N} ]+$/u

export type AlexaNameCheck =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly error: string }

/**
 * Validate an operator-typed Alexa name. Blank clears the override
 * (`name: null`, the device name is used).
 */
export function validateAlexaName(raw: unknown): AlexaNameCheck {
  if (raw === null || raw === undefined) return { ok: true, name: null }
  if (typeof raw !== 'string') return { ok: false, error: 'The Alexa name must be text.' }
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length === 0) return { ok: true, name: null }
  if (name.length > ALEXA_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `The Alexa name is ${name.length} characters; Amazon allows at most ${ALEXA_NAME_MAX_LENGTH}.`,
    }
  }
  if (!ALLOWED_PATTERN.test(name)) {
    return {
      ok: false,
      error:
        'The Alexa name may contain only letters, digits and spaces (Amazon rejects punctuation and special characters).',
    }
  }
  return { ok: true, name }
}

const StoredNameSchema = z.string()

/**
 * The saved Alexa name in a per-device store blob, or null (never saved, or a
 * stored value that no longer validates: the device name is used rather than
 * pushing a name Amazon would refuse).
 */
export function readAlexaName(store: Readonly<Record<string, unknown>>): string | null {
  const parsed = StoredNameSchema.safeParse(store[ALEXA_NAME_KEY])
  if (!parsed.success) return null
  const check = validateAlexaName(parsed.data)
  return check.ok ? check.name : null
}
