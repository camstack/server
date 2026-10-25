import type { ChargingStatus } from './device-type.js'

export interface IBatteryOperated {
  readonly batteryLevel: number
  readonly sleeping: boolean
  readonly chargingStatus: ChargingStatus
}

export interface IRebootable {
  reboot(): Promise<void>
}

export interface INativeSnapshot {
  getSnapshot(): Promise<Buffer>
}

export interface IDoorbellButton {
  /** Subscribe to doorbell press events. Returns unsubscribe function. */
  onDoorbellPressed(callback: (timestamp: number) => void): () => void
}

export interface ITwoWayAudio {
  /** Start two-way audio session */
  startAudio(): Promise<void>
  /** Stop two-way audio session */
  stopAudio(): Promise<void>
}

export interface IPanTiltZoom {
  pan(direction: 'left' | 'right', speed?: number): Promise<void>
  tilt(direction: 'up' | 'down', speed?: number): Promise<void>
  zoom(direction: 'in' | 'out', speed?: number): Promise<void>
  stop(): Promise<void>
}
