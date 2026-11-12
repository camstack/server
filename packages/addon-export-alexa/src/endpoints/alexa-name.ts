/**
 * The Alexa naming rule (D875, amended by D1049): what a device may be called in Alexa.
 *
 * The name itself is the generic `device-export` exposed name (D1049): stored per skill
 * instance in this addon's per-device store, saved through `setExposedName`, and used as the
 * endpoint `friendlyName`. It never reaches the endpoint id (`<deviceId>__dev`), so renaming
 * updates the SAME Alexa device on the next AddOrUpdateReport instead of creating a duplicate.
 * This module holds only Amazon's rule, and the key of the retired Alexa-only name the
 * migration reads.
 *
 * Amazon's friendlyName rule (Alexa.Discovery objects, endpoint object): "Up
 * to 256 alphanumeric characters and spaces. Don't include special characters
 * or punctuation." Letters of any script count as alphanumeric, so an Italian
 * name keeps its accents. The validator rejects what Amazon would reject, with
 * a message the operator can act on.
 */
import { checkExposedName, type ExposedNameCheck, type ExposedNameValidator } from '@camstack/types'

/**
 * Per-device store key of the RETIRED Alexa-only name (one per device, shared by every skill).
 * Only the migration `export-alexa/2026-11-12-alexa-name-to-exposed-name` reads it.
 */
export const LEGACY_ALEXA_NAME_KEY = 'alexaName'

export const ALEXA_NAME_MAX_LENGTH = 256

/** Letters (any script, with their combining marks), digits and spaces. */
const ALLOWED_PATTERN = /^[\p{L}\p{M}\p{N} ]+$/u

/** Amazon's rule over a normalised, non-blank name. */
export const alexaNameValidator: ExposedNameValidator = (name) => {
  if (name.length > ALEXA_NAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: `The Alexa name is ${name.length} characters; Amazon allows at most ${ALEXA_NAME_MAX_LENGTH}.`,
    }
  }
  if (!ALLOWED_PATTERN.test(name)) {
    return {
      ok: false,
      reason:
        'The Alexa name may contain only letters, digits and spaces (Amazon rejects punctuation and special characters).',
    }
  }
  return { ok: true, name }
}

/** Validate an operator-typed Alexa name. Blank clears it (`name: null`, the device name is used). */
export function validateAlexaName(raw: unknown): ExposedNameCheck {
  return checkExposedName(raw, alexaNameValidator)
}
