/**
 * The rule match as a command-origin claim (D705), and back.
 *
 * `actions.run` carries it out of band. The alarm panel reads it off the cap call
 * the Action makes and presses `triggerFromRule` with the same ref the retired
 * executor handed to `actuate`.
 */

import type { RuleFireOrigin } from '@camstack/types'
import type { NcRuleFireRef } from './rule-engine.js'

/** The claim fields of a fire ref. Absent optionals stay absent. */
export function ruleFireOriginOf(ref: NcRuleFireRef): RuleFireOrigin {
  return {
    ruleId: ref.ruleId,
    ruleName: ref.ruleName,
    deviceId: ref.deviceId,
    recordId: ref.recordId,
    timestamp: ref.timestamp,
    ...(ref.sourceDeviceId !== undefined ? { sourceDeviceId: ref.sourceDeviceId } : {}),
    ...(ref.trackId !== undefined ? { trackId: ref.trackId } : {}),
    ...(ref.eventId !== undefined ? { eventId: ref.eventId } : {}),
    ...(ref.className !== undefined ? { className: ref.className } : {}),
    ...(ref.label !== undefined ? { label: ref.label } : {}),
    ...(ref.zones !== undefined ? { zones: [...ref.zones] } : {}),
    ...(ref.confidence !== undefined ? { confidence: ref.confidence } : {}),
    ...(ref.sensorChange !== undefined
      ? {
          sensorChange: {
            name: ref.sensorChange.name,
            kind: ref.sensorChange.kind,
            state: ref.sensorChange.state,
          },
        }
      : {}),
    ...(ref.extraStills !== undefined
      ? {
          extraStills: ref.extraStills.map((still) => ({
            ownerId: still.ownerId,
            cameraId: still.cameraId,
          })),
        }
      : {}),
  }
}

/** The fire ref a claim carried, for `triggerFromRule`. */
export function fireRefOf(fire: RuleFireOrigin): NcRuleFireRef {
  return {
    ruleId: fire.ruleId,
    ruleName: fire.ruleName,
    deviceId: fire.deviceId,
    recordId: fire.recordId,
    timestamp: fire.timestamp,
    ...(fire.sourceDeviceId !== undefined ? { sourceDeviceId: fire.sourceDeviceId } : {}),
    ...(fire.trackId !== undefined ? { trackId: fire.trackId } : {}),
    ...(fire.eventId !== undefined ? { eventId: fire.eventId } : {}),
    ...(fire.className !== undefined ? { className: fire.className } : {}),
    ...(fire.label !== undefined ? { label: fire.label } : {}),
    ...(fire.zones !== undefined ? { zones: [...fire.zones] } : {}),
    ...(fire.confidence !== undefined ? { confidence: fire.confidence } : {}),
    ...(fire.sensorChange !== undefined
      ? {
          sensorChange: {
            name: fire.sensorChange.name,
            kind: fire.sensorChange.kind,
            state: fire.sensorChange.state,
          },
        }
      : {}),
    ...(fire.extraStills !== undefined
      ? {
          extraStills: fire.extraStills.map((still) => ({
            ownerId: still.ownerId,
            cameraId: still.cameraId,
          })),
        }
      : {}),
  }
}
