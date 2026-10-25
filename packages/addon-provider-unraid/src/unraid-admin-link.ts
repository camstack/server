/**
 * `device-admin-link` for Unraid-backed devices.
 *
 * The cleanest case in the repo: the connection settings an Unraid instance is
 * configured with LITERALLY describe the management page —
 * `{ host, port, https }`, where `port` is described in the settings schema as
 * "WebGUI port (80 plain, 443 https)" — it IS the page's port. Nothing here is
 * inferred, nothing is assumed, and the port is not a control port wearing
 * an HTTP port's name (which is the Reolink trap).
 *
 * Every device the addon owns — the Hub, the instance Container and each entity
 * child (array status, a Docker container's switch, a share's usage) — is a
 * view of the SAME server, so they all resolve to that server's WebGUI. There
 * is no per-entity deep link: the WebGUI's Docker and Shares pages exist but
 * their routes are version-dependent, and a button that lands on a 404 after an
 * Unraid upgrade is worse than one that lands on the dashboard.
 *
 * The `apiKey` lives in the same connection object and never travels: the URL
 * is built by `buildDeviceAdminUrl`, which takes no credential parameter.
 */
import {
  buildDeviceAdminUrl,
  type DeviceAdminLink,
  deviceAdminLinkCapability,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { unraidInstances } from './unraid-node-resolver.js'

/**
 * How this device reaches its connection settings. The Hub HOLDS them; every
 * other device resolves them through the live manager registered under the
 * Hub's `stableId`.
 */
export type UnraidAdminLinkSource =
  | { readonly kind: 'own'; readonly connection: UnraidWebGuiConnection }
  | { readonly kind: 'instance'; readonly instanceId: string }

/** The three fields of the connection this module reads. */
export interface UnraidWebGuiConnection {
  readonly host: string
  readonly port: number
  readonly https: boolean
}

export function registerUnraidAdminLink(
  ctx: DeviceContext,
  deviceId: number,
  source: UnraidAdminLinkSource,
  /** Re-read on every call for the Hub, whose connection the operator edits. */
  readOwnConnection?: () => UnraidWebGuiConnection,
): void {
  const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
    getAdminLink: async (input): Promise<DeviceAdminLink | null> => {
      if (input.deviceId !== deviceId) {
        throw new Error(
          `UnraidAdminLink: deviceId mismatch, expected ${deviceId}, got ${input.deviceId}`,
        )
      }

      let connection: UnraidWebGuiConnection | null = null
      if (source.kind === 'own') {
        connection = readOwnConnection !== undefined ? readOwnConnection() : source.connection
      } else {
        const manager = unraidInstances.getManager(source.instanceId)
        if (manager === null) {
          // The instance is not up. Unknown, and reported as such — a child of
          // a down server is not a child of a server with no WebGUI.
          ctx.logger.debug('unraid admin link unavailable: no live manager', {
            tags: { deviceId },
            meta: { instanceId: source.instanceId },
          })
          return null
        }
        connection = manager.getConnection()
      }

      const built = buildDeviceAdminUrl({
        host: connection.host,
        port: connection.port,
        scheme: connection.https ? 'https' : 'http',
        path: '/',
      })
      if (!built.ok) {
        ctx.logger.debug('unraid admin link unavailable', {
          tags: { deviceId },
          meta: { reason: built.reason },
        })
        return null
      }

      return {
        url: built.url,
        label: 'Unraid WebGUI',
        target: 'integration',
        host: connection.host,
      }
    },
  }

  ctx.registerNativeCap(deviceAdminLinkCapability, provider)
}
