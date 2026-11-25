/**
 * A frame refused because its inference device is unusable is said ONCE per
 * camera per change — not once per frame (planning#720: 17 641 `runInference
 * failed` lines in one day, all carrying the same sentence).
 *
 * The executor's refusal crosses the cap boundary as an error MESSAGE (the
 * class does not survive the wire), so it is recognised by the sentence
 * `InferenceDeviceUnusableError` writes.
 */

/** The state an executor refusal names. */
export type InferenceDeviceRefusalState = 'failed' | 'backoff'

/** The device an executor refusal names, and why. */
export interface InferenceDeviceRefusal {
  readonly deviceKey: string
  readonly state: InferenceDeviceRefusalState
}

const REFUSAL = /inference device "([^"]+)" is (failed|backoff)\b/

/** The refusal an error message carries, or `null` when it is any other fault. */
export function inferenceDeviceRefusalOf(message: string): InferenceDeviceRefusal | null {
  const match = REFUSAL.exec(message)
  if (match === null) return null
  const deviceKey = match[1]
  const state = match[2]
  if (deviceKey === undefined || (state !== 'failed' && state !== 'backoff')) return null
  return { deviceKey, state }
}

/** Per camera, the refusal last said — so each change is logged once. */
export class InferenceRefusalNotes {
  private readonly said = new Map<number, string>()

  /** True when this refusal is NEW for the camera (a line is owed). */
  refused(deviceId: number, refusal: InferenceDeviceRefusal): boolean {
    const state = `${refusal.deviceKey}|${refusal.state}`
    if (this.said.get(deviceId) === state) return false
    this.said.set(deviceId, state)
    return true
  }

  /** A frame ran: true when the camera had been refused (a "resumed" line is owed). */
  served(deviceId: number): boolean {
    return this.said.delete(deviceId)
  }
}
