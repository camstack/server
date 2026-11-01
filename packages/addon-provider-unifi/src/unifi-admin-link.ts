/**
 * `device-admin-link` for UniFi-backed devices.
 *
 * A UniFi access point or switch has no management page of its own — it is
 * adopted by, and configured from, the controller. So every device this addon
 * owns (the controller Gateway, an infra Container, a port/feature child) resolves
 * to the CONTROLLER's UI, `target: 'integration'`, labelled as such so an
 * operator knows before clicking that he is not landing on the AP.
 *
 * ## What is known, and the one thing that is not
 *
 * `host` and `port` are the operator's own controller settings — `port` is
 * described in the schema as "Controller HTTPS port (443 on UniFi OS, 8443 on
 * legacy)", so it IS the UI's port. There is no `https` boolean because UniFi
 * has no plaintext mode; https is a fact about the product, not an assumption.
 *
 * What is NOT known is a per-device deep link. `UnifiInfraSnapshot` carries no
 * `ip` (id, name, model, cpu, clients, state, uptime, ports, led, online — that
 * is the whole shape), and the controller's own per-device route embeds the
 * site slug and a UI-version-dependent path. Inventing one would produce a
 * button that lands on a redirect-to-dashboard at best and a 404 after the next
 * controller upgrade. The controller root is what this provider can honestly
 * say, so it is what it says.
 *
 * `apiKey` / `username` / `password` sit in the same connection object and
 * never travel: `buildDeviceAdminUrl` has no parameter they could ride in.
 */
import {
  buildDeviceAdminUrl,
  type DeviceAdminLink,
  deviceAdminLinkCapability,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { unifiControllers } from './unifi-node-resolver.js'

/** The two fields of the controller connection this module reads. */
export interface UnifiControllerEndpoint {
  readonly host: string
  readonly port: number
}

/** Every device resolves the endpoint through its integration's live manager. */
export interface UnifiAdminLinkSource {
  readonly integrationId: string
}

export function registerUnifiAdminLink(
  ctx: DeviceContext,
  deviceId: number,
  source: UnifiAdminLinkSource,
): void {
  const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
    getAdminLink: async (input): Promise<DeviceAdminLink | null> => {
      if (input.deviceId !== deviceId) {
        throw new Error(
          `UnifiAdminLink: deviceId mismatch, expected ${deviceId}, got ${input.deviceId}`,
        )
      }

      const manager = unifiControllers.getManager(source.integrationId)
      if (manager === null) {
        ctx.logger.debug('unifi admin link unavailable: no live manager', {
          tags: { deviceId },
          meta: { integrationId: source.integrationId },
        })
        return null
      }
      const endpoint: UnifiControllerEndpoint = manager.getConnection()

      const built = buildDeviceAdminUrl({
        host: endpoint.host,
        port: endpoint.port,
        scheme: 'https',
        path: '/',
      })
      if (!built.ok) {
        ctx.logger.debug('unifi admin link unavailable', {
          tags: { deviceId },
          meta: { reason: built.reason },
        })
        return null
      }

      return {
        url: built.url,
        label: 'UniFi controller',
        target: 'integration',
        host: endpoint.host,
      }
    },
  }

  ctx.registerNativeCap(deviceAdminLinkCapability, provider)
}
