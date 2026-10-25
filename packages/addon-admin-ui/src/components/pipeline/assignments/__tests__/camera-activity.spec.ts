import { describe, expect, it } from 'vitest'
import { cameraActivity, filterByActivities, type CameraActivity } from '../camera-activity'

describe('cameraActivity', () => {
  it('prefers fresh metrics over a pipeline assignment', () => {
    expect(cameraActivity({ hasPipelineAssignment: true, hasFreshMetrics: true })).toBe('active')
  })

  it('is recently-active when assigned but metrics are not fresh', () => {
    expect(cameraActivity({ hasPipelineAssignment: true, hasFreshMetrics: false })).toBe(
      'recently-active',
    )
  })

  it('is inactive with no assignment and no fresh metrics', () => {
    expect(cameraActivity({ hasPipelineAssignment: false, hasFreshMetrics: false })).toBe(
      'inactive',
    )
  })

  it('is active with fresh metrics even without a persisted assignment record', () => {
    expect(cameraActivity({ hasPipelineAssignment: false, hasFreshMetrics: true })).toBe('active')
  })
})

describe('filterByActivities', () => {
  const all: readonly CameraActivity[] = ['active', 'recently-active', 'inactive']

  it('passes every activity when the selected set is empty', () => {
    const selected = new Set<CameraActivity>()
    for (const activity of all) {
      expect(filterByActivities(activity, selected)).toBe(true)
    }
  })

  it('passes only activities present in the selected set', () => {
    const selected = new Set<CameraActivity>(['active', 'inactive'])
    expect(filterByActivities('active', selected)).toBe(true)
    expect(filterByActivities('recently-active', selected)).toBe(false)
    expect(filterByActivities('inactive', selected)).toBe(true)
  })
})
