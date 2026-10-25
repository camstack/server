declare module 'onvif' {
  interface OnvifDeviceInfo {
    readonly manufacturer: string
    readonly model: string
    readonly firmwareVersion: string
    readonly serialNumber: string
  }

  interface OnvifStreamResult {
    readonly uri: string
  }

  interface OnvifResolution {
    readonly width?: number
    readonly height?: number
  }

  interface OnvifProfile {
    readonly $?: { readonly token?: string }
    readonly token?: string
    readonly name: string
    readonly videoEncoderConfiguration?: {
      readonly resolution?: OnvifResolution
    }
  }

  interface OnvifPreset {
    readonly $?: { readonly token?: string }
    readonly token?: string
    readonly name?: string
  }

  type OnvifCallback<T> = (err: Error | null, result: T) => void

  export class Cam {
    readonly ptzUri?: string

    constructor(options: Record<string, unknown>, callback: (err: Error | null) => void)

    getDeviceInformation(callback: OnvifCallback<OnvifDeviceInfo>): void
    getStreamUri(options: Record<string, unknown>, callback: OnvifCallback<OnvifStreamResult>): void
    getProfiles(callback: OnvifCallback<OnvifProfile[]>): void
    getSnapshotUri(options: Record<string, unknown>, callback: OnvifCallback<OnvifStreamResult>): void
    continuousMove(options: Record<string, unknown>, callback: (err: Error | null) => void): void
    stop(options: Record<string, unknown>, callback: (err: Error | null) => void): void
    absoluteMove(options: Record<string, unknown>, callback: (err: Error | null) => void): void
    getPresets(options: Record<string, unknown>, callback: OnvifCallback<OnvifPreset | OnvifPreset[]>): void
    gotoPreset(options: Record<string, unknown>, callback: (err: Error | null) => void): void
  }

  export const Discovery: {
    on(event: string, listener: (...args: unknown[]) => void): void
    probe(options: Record<string, unknown>): void
    removeAllListeners(event: string): void
  }
}
