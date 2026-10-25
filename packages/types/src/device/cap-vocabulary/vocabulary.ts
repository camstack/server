/**
 * THE cap vocabulary (D920): one complete, cap-keyed map of what every
 * capability lets an operator DO to a device and WATCH it for — outside the
 * caps themselves, so the wording, the translations and the device-type
 * nuances live in one place a picker, a script editor and a phrase renderer
 * all read.
 *
 * Typed as {@link CapVocabularyMap}: a cap with no entry is a TypeScript
 * error here, before `scripts/check-cap-vocabulary.ts` ever runs. The order
 * of the families is the order a picker draws them in.
 */
import { ACTUATOR_CAP_VOCABULARY } from './entries/actuators.js'
import { APPLIANCE_CAP_VOCABULARY } from './entries/appliances.js'
import { CAMERA_CAP_VOCABULARY } from './entries/camera.js'
import { SENSOR_CAP_VOCABULARY } from './entries/sensors.js'
import { SYSTEM_CAP_VOCABULARY } from './entries/system.js'
import type { CapVocabularyMap, LooseCapVocabularyEntry } from './types.js'

/** Every capability's vocabulary, keyed by cap name. */
export const CAP_VOCABULARY: CapVocabularyMap = {
  ...ACTUATOR_CAP_VOCABULARY,
  ...APPLIANCE_CAP_VOCABULARY,
  ...CAMERA_CAP_VOCABULARY,
  ...SENSOR_CAP_VOCABULARY,
  ...SYSTEM_CAP_VOCABULARY,
}

/** The same map, read by a string cap name (a binding names caps as strings). */
export const CAP_VOCABULARY_BY_NAME: Readonly<Record<string, LooseCapVocabularyEntry>> =
  CAP_VOCABULARY
