import type { ClimateControlStatus } from '@camstack/types'

/** Override mapper default tempStep when the device config carries a positive step. */
export function applyPersistedClimateTempStep(
  slice: ClimateControlStatus,
  configTempStep: number | undefined,
): ClimateControlStatus {
  if (typeof configTempStep === 'number' && Number.isFinite(configTempStep) && configTempStep > 0) {
    return { ...slice, tempStep: configTempStep }
  }
  return slice
}
