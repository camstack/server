import { Discovery } from 'onvif'
import type { DiscoveredOnvifCamera } from './onvif-types'

/** Shape emitted by the `onvif` Discovery 'device' event (untyped JS library). */
interface OnvifDiscoveryDevice {
  readonly hostname: string
  readonly port?: number
  readonly name?: string
  readonly manufacturer?: string
  readonly model?: string
  readonly scopes?: readonly string[]
}

/**
 * Discovers ONVIF cameras on the local network via WS-Discovery.
 * Returns a list of found cameras after the given timeout.
 */
export async function discoverOnvifCameras(
  timeout: number = 5000,
): Promise<readonly DiscoveredOnvifCamera[]> {
  return new Promise((resolve) => {
    const cameras: DiscoveredOnvifCamera[] = []

    Discovery.on('device', (rawCam: unknown) => {
      // The 'onvif' library emits untyped JS objects. OnvifDiscoveryDevice documents
      // the observed shape — this is an intentional external-library boundary cast.
      const cam = rawCam as OnvifDiscoveryDevice
      cameras.push({
        host: cam.hostname,
        port: cam.port ?? 80,
        name: cam.name,
        manufacturer: cam.manufacturer,
        model: cam.model,
        scopes: cam.scopes,
      })
    })

    Discovery.probe({ timeout })

    setTimeout(() => {
      Discovery.removeAllListeners('device')
      resolve(cameras)
    }, timeout + 500)
  })
}
