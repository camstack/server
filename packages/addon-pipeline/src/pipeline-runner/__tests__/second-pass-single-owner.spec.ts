/**
 * The second pass's planning has ONE owner: `@camstack/types`
 * (`pipeline/second-pass/`). The runner's modules re-export it, so the live
 * runner and the offline accuracy eval (`addon-benchmark`) run the same
 * functions — identity, not a copy that happens to agree today.
 */
import * as types from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OBJECT_DETECTION_STEP_ID } from '../../detection-pipeline/default-detection-model.js'
import * as cropPlan from '../motion-crop-plan.js'
import * as recovery from '../small-subject-recovery.js'

describe('second-pass planning — single owner in @camstack/types', () => {
  it('the runner re-exports the shared planners, never its own copy', () => {
    expect(recovery.planRecoveryCrops).toBe(types.planRecoveryCrops)
    expect(recovery.remapCropDetections).toBe(types.remapCropDetections)
    expect(recovery.fuseRecoveredDetections).toBe(types.fuseRecoveredDetections)
    expect(recovery.selectRecoveryStep).toBe(types.selectRecoveryStep)
    expect(recovery.countRecoverySkips).toBe(types.countRecoverySkips)
    expect(recovery.squareAround).toBe(types.squareAround)
    expect(cropPlan.planMotionCrops).toBe(types.planMotionCrops)
    expect(cropPlan.planMotionCropRegions).toBe(types.planMotionCropRegions)
    expect(cropPlan.applyCropClassFloors).toBe(types.applyCropClassFloors)
    expect(cropPlan.readRecoveryRecipeForSteps).toBe(types.readRecoveryRecipeForSteps)
  })

  it('the shared constants are the runner constants', () => {
    expect(recovery.RECOVERY_VIEW_PX).toBe(types.RECOVERY_VIEW_PX)
    expect(cropPlan.CROP_CLASS_FLOORS).toBe(types.CROP_CLASS_FLOORS)
    expect(OBJECT_DETECTION_STEP_ID).toBe(types.OBJECT_DETECTION_STEP_ID)
  })

  it('the stateful mirror stays in the runner', () => {
    expect(typeof recovery.MotionRegionMirror).toBe('function')
    expect('MotionRegionMirror' in types).toBe(false)
  })
})
