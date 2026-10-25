import type { NavigationActionId, NavigationMoveCommand } from '@camstack/types'

/**
 * Pure translation of the `navigation` capability surface into calls on the
 * TYPED `DreameCameraController` that `@apocaliss92/nodedreame@1.12` exposes
 * (`VacuumDevice.createCameraController()`). Until 1.12 this module built the
 * raw MIoT writes itself; the controller now owns the wire (drive payloads,
 * action ids, sound ids), and this module owns only the CAP → METHOD mapping,
 * which is what a unit test can pin without a live handle.
 *
 * Drive semantics carried over: `drive(spdv, spdw)` is momentary and is sent
 * ~1 Hz while a direction is held (the UI owns the cadence), `spdv` = forward
 * (200), `spdw` = turn (+45 left, -45 right, 180 turn-around), 0/0 = stop.
 * The controller says drive is valid only while the camera stream is open —
 * the same rule the raw write had; the navigation panel is used while
 * watching the stream.
 */

/** The controller surface this module needs — a structural subset of `DreameCameraController`. */
export interface CameraControllerLike {
  drive(spdv: number, spdw: number): Promise<unknown>
  stopWork(): Promise<unknown>
  startPersonFollow(): Promise<unknown>
  spotClean(): Promise<unknown>
  findPet(): Promise<unknown>
  playSound(soundId: number): Promise<unknown>
  runVacuumAction(
    action: 'startClean' | 'pauseClean' | 'stopClean' | 'dockWash' | 'autoEmpty',
  ): Promise<unknown>
  goToPoint(spoint: number[][], tpoint: number[][]): Promise<unknown>
  /** 40..100 = manual level; 101 = auto. */
  setFillLight(value: number): Promise<unknown>
  /** `true` = full on, `false` = auto. */
  setFillLightAuto(full: boolean): Promise<unknown>
  returnToDock(): Promise<unknown>
  locate(): Promise<unknown>
}

/** One controller call, as data — so the mapping is testable and loggable. */
export type ControllerCall =
  | { readonly method: 'drive'; readonly spdv: number; readonly spdw: number }
  | { readonly method: 'stopWork' }
  | { readonly method: 'startPersonFollow' }
  | { readonly method: 'spotClean' }
  | { readonly method: 'findPet' }
  | { readonly method: 'playSound'; readonly soundId: number }
  | {
      readonly method: 'runVacuumAction'
      readonly action: 'startClean' | 'pauseClean' | 'stopClean' | 'dockWash' | 'autoEmpty'
    }
  | { readonly method: 'goToPoint'; readonly x: number; readonly y: number }
  | { readonly method: 'setFillLight'; readonly value: number }
  | { readonly method: 'setFillLightAuto'; readonly full: boolean }
  | { readonly method: 'returnToDock' }
  | { readonly method: 'locate' }

/** Forward throttle magnitude for a full-forward nudge (device speed units). */
const FORWARD_SPEED = 200
/** Turn magnitudes: left = +45, right = -45, spin/turn-around = +180. */
const TURN_LEFT = 45
const TURN_RIGHT = -45
const SPIN = 180
/** The `setFillLight` value that selects auto. */
const FILL_LIGHT_AUTO = 101

export interface DreameDriveVector {
  readonly spdv: number
  readonly spdw: number
}

/**
 * Map a normalized {@link NavigationMoveCommand} ([-1, 1] per axis) to a discrete
 * Dreame drive vector. The robot has no proportional joystick, so intensity is
 * quantized to the RE'd discrete nudges. Priority: forward, then spin
 * (tilt-down), then turn (pan). An all-zero / empty command is a stop.
 */
export function driveVector(cmd: NavigationMoveCommand): DreameDriveVector {
  const pan = cmd.pan ?? 0
  const tilt = cmd.tilt ?? 0
  if (tilt > 0) return { spdv: FORWARD_SPEED, spdw: 0 }
  if (tilt < 0) return { spdv: 0, spdw: SPIN }
  if (pan < 0) return { spdv: 0, spdw: TURN_LEFT }
  if (pan > 0) return { spdv: 0, spdw: TURN_RIGHT }
  return { spdv: 0, spdw: 0 }
}

export function moveCall(cmd: NavigationMoveCommand): ControllerCall {
  const { spdv, spdw } = driveVector(cmd)
  return { method: 'drive', spdv, spdw }
}

/** The explicit halt: a zero drive vector. */
export function stopCall(): ControllerCall {
  return { method: 'drive', spdv: 0, spdw: 0 }
}

/** Fill light on (full) / off (back to auto) — the control that works anytime. */
export function lightOnCall(on: boolean): ControllerCall {
  return { method: 'setFillLightAuto', full: on }
}

/** Fill-light mode: auto, or manual at `level` (40..100). Camera-service; needs a stream. */
export function lightModeCall(mode: 'auto' | 'manual', level?: number): ControllerCall {
  return { method: 'setFillLight', value: mode === 'auto' ? FILL_LIGHT_AUTO : (level ?? 100) }
}

export function lightLevelCall(level: number): ControllerCall {
  return lightModeCall('manual', level)
}

export function playSoundCall(soundId: number): ControllerCall {
  return { method: 'playSound', soundId }
}

export interface GoToPoint {
  readonly x: number
  readonly y: number
}

export function goToPointCall(point: GoToPoint): ControllerCall {
  return { method: 'goToPoint', x: point.x, y: point.y }
}

/** A discrete {@link NavigationActionId} → the controller method that performs it. */
export function actionCall(actionId: NavigationActionId): ControllerCall {
  switch (actionId) {
    case 'goHome':
      return { method: 'returnToDock' }
    case 'locate':
      return { method: 'locate' }
    case 'spotClean':
      return { method: 'spotClean' }
    case 'findPet':
      return { method: 'findPet' }
    case 'personFollow':
      return { method: 'startPersonFollow' }
    case 'stop':
      return { method: 'stopWork' }
    case 'startClean':
      return { method: 'runVacuumAction', action: 'startClean' }
    case 'pauseClean':
      return { method: 'runVacuumAction', action: 'pauseClean' }
    case 'dockWash':
      return { method: 'runVacuumAction', action: 'dockWash' }
    case 'autoEmpty':
      return { method: 'runVacuumAction', action: 'autoEmpty' }
    case 'flashOn':
      return lightOnCall(true)
    case 'flashOff':
      return lightOnCall(false)
  }
}

/** Perform one call on a controller. Exhaustive — a new method is a compile error here. */
export async function runControllerCall(
  controller: CameraControllerLike,
  call: ControllerCall,
): Promise<void> {
  switch (call.method) {
    case 'drive':
      await controller.drive(call.spdv, call.spdw)
      return
    case 'stopWork':
      await controller.stopWork()
      return
    case 'startPersonFollow':
      await controller.startPersonFollow()
      return
    case 'spotClean':
      await controller.spotClean()
      return
    case 'findPet':
      await controller.findPet()
      return
    case 'playSound':
      await controller.playSound(call.soundId)
      return
    case 'runVacuumAction':
      await controller.runVacuumAction(call.action)
      return
    case 'goToPoint':
      await controller.goToPoint([[call.x, call.y]], [[call.x, call.y]])
      return
    case 'setFillLight':
      await controller.setFillLight(call.value)
      return
    case 'setFillLightAuto':
      await controller.setFillLightAuto(call.full)
      return
    case 'returnToDock':
      await controller.returnToDock()
      return
    case 'locate':
      await controller.locate()
      return
  }
}
