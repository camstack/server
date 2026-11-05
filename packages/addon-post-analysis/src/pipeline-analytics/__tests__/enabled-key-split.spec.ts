/**
 * One settings key `enabled` used to mean two things in this addon's store: "Face recognition on"
 * and "Suppress parked objects". Both resolvers read `raw['enabled']`, so toggling one flipped the
 * other. Each switch now has its own key, and no field key is declared twice in the form.
 *
 * Disarm: rename either key back to `enabled` and the isolation and unique-key specs fail.
 */
import { describe, expect, it } from 'vitest'
import { resolveFaceSettings } from '../face-settings.js'
import { buildGlobalSettingsSchema } from '../settings-schema.js'
import { resolveStationarySettings } from '../stationary-settings.js'

const FACE_KEY = 'faceRecognitionEnabled'
const STATIONARY_KEY = 'stationarySuppressionEnabled'

describe('the face and stationary switches are independent keys', () => {
  it('turning face recognition off leaves parked-object suppression on', () => {
    const raw = { [FACE_KEY]: false }
    expect(resolveFaceSettings(raw).faceRecognitionEnabled).toBe(false)
    expect(resolveStationarySettings(raw).stationarySuppressionEnabled).toBe(true)
  })

  it('turning parked-object suppression off leaves face recognition on', () => {
    const raw = { [STATIONARY_KEY]: false }
    expect(resolveStationarySettings(raw).stationarySuppressionEnabled).toBe(false)
    expect(resolveFaceSettings(raw).faceRecognitionEnabled).toBe(true)
  })

  it('the retired shared key `enabled` is read by neither resolver', () => {
    const raw = { enabled: false }
    expect(resolveFaceSettings(raw).faceRecognitionEnabled).toBe(true)
    expect(resolveStationarySettings(raw).stationarySuppressionEnabled).toBe(true)
  })

  it('no field key is declared twice in the whole form', () => {
    const keys = buildGlobalSettingsSchema()
      .sections.flatMap((section) => section.fields)
      .flatMap((field) => ('key' in field ? [field.key] : []))
    const seen = new Set<string>()
    const duplicated = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)))
    expect(duplicated).toEqual([])
    expect(keys).toContain(FACE_KEY)
    expect(keys).toContain(STATIONARY_KEY)
  })
})
