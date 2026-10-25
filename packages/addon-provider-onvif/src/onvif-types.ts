export interface OnvifProviderConfig {
  readonly id: string
  readonly name: string
  /** Discovery settings. A scan runs only when an operator asks for one. */
  readonly discovery?: {
    readonly timeout: number // WS-Discovery listen window in ms (default: 5000)
  }
  /** Manually added cameras (in addition to discovered) */
  readonly cameras?: readonly OnvifCameraConfig[]
  /** Default credentials for discovered cameras */
  readonly defaultUsername?: string
  readonly defaultPassword?: string
}

export interface OnvifCameraConfig {
  readonly id: string
  readonly name: string
  readonly host: string // IP or hostname
  readonly port?: number // default: 80
  readonly username?: string
  readonly password?: string
  /** Override RTSP URL (skip ONVIF stream URI query) */
  readonly rtspUrl?: string
}

export interface DiscoveredOnvifCamera {
  readonly host: string
  readonly port: number
  readonly name?: string
  readonly manufacturer?: string
  readonly model?: string
  readonly firmwareVersion?: string
  readonly hardwareId?: string
  readonly scopes?: readonly string[]
}
