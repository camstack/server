import type { IScopedLogger } from '@camstack/types'
import { Cam } from 'onvif'

/**
 * How long one ONVIF `ContinuousMove` runs before the camera stops itself, ms.
 * The DENOMINATOR of "how far did the head travel per pulse", so it is named
 * and exported rather than left inline where no caller could read it.
 */
export const ONVIF_PTZ_TIMEOUT_MS = 1000

export class OnvifClient {
  private cam: InstanceType<typeof Cam> | null = null

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly username: string,
    private readonly password: string,
    private readonly logger: IScopedLogger,
  ) {}

  /** Connect to the camera */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cam = new Cam(
        {
          hostname: this.host,
          port: this.port,
          username: this.username,
          password: this.password,
        },
        (err: Error | null) => {
          if (err) {
            reject(err)
          } else {
            this.logger.info('Connected to ONVIF camera', {
              meta: { host: this.host, port: this.port },
            })
            resolve()
          }
        },
      )
    })
  }

  /** Get device info */
  async getDeviceInfo(): Promise<{
    manufacturer: string
    model: string
    firmwareVersion: string
    serialNumber: string
  }> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.getDeviceInformation((err, info) => {
        if (err) reject(err)
        else resolve(info)
      })
    })
  }

  /** Get RTSP stream URI */
  async getStreamUri(profileToken?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      const options: Record<string, unknown> = { protocol: 'RTSP' }
      if (profileToken) options.profileToken = profileToken
      this.cam.getStreamUri(options, (err, stream) => {
        if (err) reject(err)
        else resolve(stream.uri)
      })
    })
  }

  /** Get available media profiles */
  async getProfiles(): Promise<
    Array<{ token: string; name: string; videoWidth?: number; videoHeight?: number }>
  > {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.getProfiles((err, profiles) => {
        if (err) reject(err)
        else
          resolve(
            profiles.map((p) => ({
              token: p.$?.token ?? p.token ?? '',
              name: p.name,
              videoWidth: p.videoEncoderConfiguration?.resolution?.width,
              videoHeight: p.videoEncoderConfiguration?.resolution?.height,
            })),
          )
      })
    })
  }

  /** Get snapshot URI */
  async getSnapshotUri(profileToken?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      const options: Record<string, unknown> = {}
      if (profileToken) options.profileToken = profileToken
      this.cam.getSnapshotUri(options, (err, res) => {
        if (err) reject(err)
        else resolve(res.uri)
      })
    })
  }

  /** Check if PTZ is supported */
  hasPtz(): boolean {
    return this.cam?.ptzUri != null
  }

  /** PTZ move (continuous) */
  async ptzMove(options: { x?: number; y?: number; zoom?: number; speed?: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.continuousMove(
        {
          x: options.x ?? 0,
          y: options.y ?? 0,
          zoom: options.zoom ?? 0,
          timeout: ONVIF_PTZ_TIMEOUT_MS,
        },
        (err: Error | null) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })
  }

  /** PTZ stop */
  async ptzStop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.stop({}, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** PTZ absolute move */
  async ptzAbsoluteMove(options: { x: number; y: number; zoom: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.absoluteMove(
        {
          x: options.x,
          y: options.y,
          zoom: options.zoom,
        },
        (err: Error | null) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })
  }

  /** Get PTZ presets */
  async getPtzPresets(): Promise<Array<{ token: string; name: string }>> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.getPresets({}, (err, presets) => {
        if (err) reject(err)
        else {
          const list = Array.isArray(presets) ? presets : [presets]
          resolve(
            list.filter(Boolean).map((p) => ({
              token: p.$?.token ?? String(p.token ?? ''),
              name: p.name ?? p.$?.token ?? 'Preset',
            })),
          )
        }
      })
    })
  }

  /** Go to PTZ preset */
  async gotoPreset(presetToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.cam) return reject(new Error('Not connected'))
      this.cam.gotoPreset({ preset: presetToken }, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  disconnect(): void {
    this.cam = null
  }
}
