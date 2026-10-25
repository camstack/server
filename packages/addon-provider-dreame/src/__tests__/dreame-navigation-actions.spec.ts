import { describe, expect, it, vi } from 'vitest'
import {
  actionCall,
  type CameraControllerLike,
  driveVector,
  goToPointCall,
  lightLevelCall,
  lightModeCall,
  lightOnCall,
  moveCall,
  playSoundCall,
  runControllerCall,
  stopCall,
} from '../devices/dreame-navigation-actions.js'

describe('driveVector', () => {
  it('maps tilt-up to forward, tilt-down to spin, pan to turn, and empty to stop', () => {
    expect(driveVector({ tilt: 1 })).toEqual({ spdv: 200, spdw: 0 })
    expect(driveVector({ tilt: -1 })).toEqual({ spdv: 0, spdw: 180 })
    expect(driveVector({ pan: -1 })).toEqual({ spdv: 0, spdw: 45 })
    expect(driveVector({ pan: 1 })).toEqual({ spdv: 0, spdw: -45 })
    expect(driveVector({})).toEqual({ spdv: 0, spdw: 0 })
  })

  it('prioritizes forward over turn when both axes are set', () => {
    expect(driveVector({ pan: 1, tilt: 1 })).toEqual({ spdv: 200, spdw: 0 })
  })
})

describe('cap → controller calls', () => {
  it('move and stop are drive writes', () => {
    expect(moveCall({ pan: -1 })).toEqual({ method: 'drive', spdv: 0, spdw: 45 })
    expect(stopCall()).toEqual({ method: 'drive', spdv: 0, spdw: 0 })
  })

  it('the light: on/off is the anytime toggle, mode and level are the camera-service value', () => {
    expect(lightOnCall(true)).toEqual({ method: 'setFillLightAuto', full: true })
    expect(lightModeCall('auto')).toEqual({ method: 'setFillLight', value: 101 })
    expect(lightModeCall('manual', 60)).toEqual({ method: 'setFillLight', value: 60 })
    expect(lightLevelCall(80)).toEqual({ method: 'setFillLight', value: 80 })
  })

  it('every action id has a controller method', () => {
    expect(actionCall('goHome')).toEqual({ method: 'returnToDock' })
    expect(actionCall('personFollow')).toEqual({ method: 'startPersonFollow' })
    expect(actionCall('stop')).toEqual({ method: 'stopWork' })
    expect(actionCall('autoEmpty')).toEqual({ method: 'runVacuumAction', action: 'autoEmpty' })
    expect(actionCall('flashOff')).toEqual({ method: 'setFillLightAuto', full: false })
    expect(playSoundCall(684)).toEqual({ method: 'playSound', soundId: 684 })
    expect(goToPointCall({ x: 1, y: 2 })).toEqual({ method: 'goToPoint', x: 1, y: 2 })
  })
})

describe('runControllerCall', () => {
  it('performs the call on the controller with the right arguments', async () => {
    const controller: CameraControllerLike = {
      drive: vi.fn(async () => undefined),
      stopWork: vi.fn(async () => undefined),
      startPersonFollow: vi.fn(async () => undefined),
      spotClean: vi.fn(async () => undefined),
      findPet: vi.fn(async () => undefined),
      playSound: vi.fn(async () => undefined),
      runVacuumAction: vi.fn(async () => undefined),
      goToPoint: vi.fn(async () => undefined),
      setFillLight: vi.fn(async () => undefined),
      setFillLightAuto: vi.fn(async () => undefined),
      returnToDock: vi.fn(async () => undefined),
      locate: vi.fn(async () => undefined),
    }
    await runControllerCall(controller, moveCall({ tilt: 1 }))
    await runControllerCall(controller, goToPointCall({ x: 3, y: 4 }))
    await runControllerCall(controller, actionCall('dockWash'))
    expect(controller.drive).toHaveBeenCalledWith(200, 0)
    expect(controller.goToPoint).toHaveBeenCalledWith([[3, 4]], [[3, 4]])
    expect(controller.runVacuumAction).toHaveBeenCalledWith('dockWash')
  })
})
