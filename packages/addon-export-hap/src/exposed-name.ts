/**
 * The HomeKit name of an exposed device (`device-export` exposed name, D1049).
 *
 * Stored per bridge instance in this addon's per-device store (D865). It becomes the accessory's
 * display name and its service names on the next (re)expose. It never reaches the accessory UUID
 * (`accessoryUuidFor(kind, deviceId, instanceId)`), so a rename keeps the same paired accessory.
 */
import type { ExposedNameValidator } from '@camstack/types'
import { HAP_NAME_MAX_LENGTH, isHapServiceName } from './mappers/builders/service-names.js'

/** Apple's rule: at most 64 characters, begins and ends with a letter or digit, HAP punctuation only. */
/** HomeKit's rule, as the derived "Name on <bridge>" field states it (D1049). */
export const HAP_NAME_RULE = `HomeKit takes up to ${HAP_NAME_MAX_LENGTH} characters, starting and ending with a letter or digit; inside, only letters, digits, spaces and ' & ! . _ : ; ( ) / , -.`

export const hapNameValidator: ExposedNameValidator = (name) => {
  if (name.length > HAP_NAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: `The HomeKit name is ${name.length} characters; HomeKit allows at most ${HAP_NAME_MAX_LENGTH}.`,
    }
  }
  if (!isHapServiceName(name)) {
    return {
      ok: false,
      reason:
        "The HomeKit name must begin and end with a letter or digit and may contain only letters, digits, spaces and ' & ! . _ : ; ( ) / , -",
    }
  }
  return { ok: true, name }
}
