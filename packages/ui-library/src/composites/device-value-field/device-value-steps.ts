/**
 * The phone flow of the device → value picker: three steps (devices, values,
 * preview). From `sm` up every region is on screen at once and the step is ignored.
 */
export type DeviceValueStep = 'devices' | 'values' | 'preview'

/** Choosing a device opens its values; clearing it returns to the list. */
export function stepAfterDevice(picked: boolean): DeviceValueStep {
  return picked ? 'values' : 'devices'
}

/** Choosing a value opens the preview (transform and "would read"). */
export function stepAfterValue(): DeviceValueStep {
  return 'preview'
}

/** Back goes one step towards the device list and stops there. */
export function stepBack(step: DeviceValueStep): DeviceValueStep {
  return step === 'preview' ? 'values' : 'devices'
}

/** A dialog that opens on a stored pick shows its values, not the empty list. */
export function initialStep(hasDevice: boolean): DeviceValueStep {
  return hasDevice ? 'values' : 'devices'
}
