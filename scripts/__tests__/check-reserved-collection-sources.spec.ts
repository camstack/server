/**
 * The reserved-source guard follows the CONSTANT that means a reservation, not
 * every constant that happens to share its spelling: `HUB_MDNS_SERVICE_TYPE`
 * is also `'camstack'` and has nothing to do with `recording`.
 */
import { describe, expect, it } from 'vitest'
import {
  constantNamesHolding,
  reservationConstantFiles,
} from '../check-reserved-collection-sources.js'

describe('reserved collection source constants', () => {
  it('reads only the reserved cap file and the reservation table', () => {
    expect(reservationConstantFiles('recording')).toEqual([
      'recording.cap.ts',
      'reserved-collection-sources.ts',
    ])
  })

  it('names the constant that holds the id in the files it is given', () => {
    const recordingCap = "export const RECORDING_SOURCE_CAMSTACK = 'camstack'\n"
    expect(constantNamesHolding('camstack', [recordingCap])).toEqual(['RECORDING_SOURCE_CAMSTACK'])
  })

  it('does not match a different value or a longer spelling', () => {
    const other = "export const X = 'camstack-hub'\nexport const Y = 'recorder'\n"
    expect(constantNamesHolding('camstack', [other])).toEqual([])
  })
})
