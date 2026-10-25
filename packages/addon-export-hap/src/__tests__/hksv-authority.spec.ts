/**
 * Who owns "record this camera" — and the switch this repo removed.
 *
 * ## The history, because it is the argument
 *
 * There was a per-camera switch here. On 2026-08-08 it defaulted ON; on
 * 2026-09-21 the operator reversed that — *"il recording deve essere off di
 * default, non deve essere attivo quando si esporta una camera su HKSV"* [recording must be off by default, it must not be active when a camera is exported to HKSV] —
 * because exporting a camera to HomeKit is a decision about EXPOSURE and
 * recording is a second decision.
 *
 * The reversal was right and the switch was still wrong. Within hours it
 * produced the defect D62 exists to forbid: the flip turned 101's stored value
 * off, but the accessory had been built under the old default and kept teeing
 * HomeKit clips, while `videoclips.listSources` — reading the new value —
 * reported that the camera had no HomeKit source at all. Two authorities over
 * one function, disagreeing, with nobody having touched anything.
 *
 * There is only one authority now, and it is not ours: iOS asks "Stream" or
 * "Stream and Allow Recording", writes the answer to
 * `CameraRecordingManagement.Active`, and hap-nodejs persists it on the
 * accessory. The operator's intent survives — exporting still does not record,
 * HomeKit asks — but nothing here stores a second copy of the answer.
 *
 * What this addon still decides is whether the camera CAN be recorded, which
 * is a fact about the camera rather than an opinion about it.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_DEVICE_SETTINGS, describeHksvCamera } from '../hap-export.addon.js'

const CAMERA = {
  deviceId: '101',
  displayName: 'Cam 101',
  mapperKind: 'camera' as const,
  settings: { streamPreference: 'auto' },
}

describe('the per-camera recording switch is gone', () => {
  it('ships no stored recording preference at all', () => {
    // A key that still shipped would be read by something eventually.
    expect('hksvRecording' in DEFAULT_DEVICE_SETTINGS).toBe(false)
  })

  it('reports what HomeKit says, not what we stored', () => {
    expect(describeHksvCamera(CAMERA, null, true).homekitRecording).toBe(true)
    expect(describeHksvCamera(CAMERA, null, false).homekitRecording).toBe(false)
  })

  it('keeps "never offered" distinct from "switched off"', () => {
    // `null` is a camera whose accessory carries no recording service — we
    // refused it. Folding that into `false` would report OUR refusal as the
    // operator's (D315, D393).
    expect(describeHksvCamera(CAMERA, null, null).homekitRecording).toBeNull()
  })

  it('says nothing about a device that is not a camera', () => {
    const lock = { ...CAMERA, mapperKind: 'generic' as const }
    expect(describeHksvCamera(lock, null, true).homekitRecording).toBeNull()
    expect(describeHksvCamera(lock, null, true).exported).toBe(false)
  })
})
