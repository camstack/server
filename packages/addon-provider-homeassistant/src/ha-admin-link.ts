/**
 * `device-admin-link` for Home-Assistant-backed devices.
 *
 * The interesting case of this capability, and the one that covers 779 of the
 * 1 012 devices on this hub. An HA-backed device has **no web server of its
 * own** — a Zigbee contact sensor has no IP at all — so its "configuration
 * page" is a page inside Home Assistant, built from the broker's base URL plus
 * the HA identifier the device already carries.
 *
 * Two subjects, because HA has two identifiers and they address different pages:
 *
 *  - **A container** is an HA *device* (registry id, `ha:<broker>:dev:<id>`).
 *    Its page is `/config/devices/device/<haDeviceId>` — the actual device
 *    configuration page, with its entities, its area and its integration.
 *  - **A child or standalone device** is an HA *entity*. HA has no stable
 *    per-entity configuration URL (`/config/entities` is a list with a modal;
 *    there is no deep link into it), so the honest address for one entity is
 *    `/history?entity_id=<entityId>`. That is a real page about exactly that
 *    entity. Inventing a `/config/entities/<id>` route that HA does not serve
 *    would be a button that opens a 404, which is worse than no button.
 *
 * **What this cannot answer, and does not pretend to.** A broker authenticated
 * by SUPERVISOR TOKEN carries no `baseUrl` at all — the supervisor proxy serves
 * HA on a relative path and the instance's address is never exposed to the
 * addon. Those devices get `null`, with a log line naming the reason. The cap
 * is still registered for them: this provider CAN answer the question for HA
 * devices in general, and for these particular ones the answer is "no page I
 * can address", which is a different statement from a Petkit feeder's, whose
 * provider never registers at all.
 *
 * **No credentials.** The broker config that holds `baseUrl` holds the
 * long-lived `accessToken` next to it. The token is never read here and never
 * travels; `parseAdminBase` REFUSES a base URL that carries userinfo rather
 * than silently stripping it, so an operator who typed his HA login into the
 * base-URL field loses the button instead of publishing the login.
 */
import {
  buildDeviceAdminUrl,
  type DeviceAdminLink,
  deviceAdminLinkCapability,
  type DeviceContext,
  type InferNativeProvider,
  parseAdminBase,
} from '@camstack/types'

/** Which HA page this camstack device corresponds to. */
export type HaAdminLinkSubject =
  /** An HA device-registry entry — the container case. */
  | { readonly kind: 'device'; readonly haDeviceId: string }
  /** A single HA entity — every child, and every standalone entity device. */
  | { readonly kind: 'entity'; readonly entityId: string }

/** Why no link could be produced. Logged, never swallowed. */
type HaAdminLinkRefusal = 'no-base-url' | 'base-unusable' | 'empty-subject' | 'build-refused'

interface SubjectPage {
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
}

function pageFor(subject: HaAdminLinkSubject, basePath: string): SubjectPage | null {
  if (subject.kind === 'device') {
    if (subject.haDeviceId.length === 0) return null
    return { path: `${basePath}/config/devices/device/${encodeURIComponent(subject.haDeviceId)}` }
  }
  if (subject.entityId.length === 0) return null
  return { path: `${basePath}/history`, query: { entity_id: subject.entityId } }
}

/**
 * Register `device-admin-link` for one HA-backed device.
 *
 * The base URL is fetched from the broker on first ask and memoised, the same
 * read-through `ha-image-device.ts` uses — a device never keeps a second copy
 * of a broker fact (D224), and the memo is dropped on refusal so a broker that
 * gains a `baseUrl` later starts answering without a restart.
 */
export function registerHaAdminLink(
  ctx: DeviceContext,
  deviceId: number,
  brokerId: string,
  subject: HaAdminLinkSubject,
): void {
  let cachedBaseUrl: string | null = null

  const refuse = (
    reason: HaAdminLinkRefusal,
    meta: Readonly<Record<string, unknown>> = {},
  ): null => {
    ctx.logger.debug('home-assistant admin link unavailable', {
      tags: { deviceId },
      meta: { reason, brokerId, subject: subject.kind, ...meta },
    })
    return null
  }

  const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
    getAdminLink: async (input): Promise<DeviceAdminLink | null> => {
      if (input.deviceId !== deviceId) {
        throw new Error(
          `HaAdminLink: deviceId mismatch, expected ${deviceId}, got ${input.deviceId}`,
        )
      }

      if (cachedBaseUrl === null) {
        const cfg = await ctx.api.broker.getBrokerConfig.query({ id: brokerId })
        const raw = cfg?.['baseUrl']
        if (typeof raw !== 'string' || raw.length === 0) {
          // Supervisor-token brokers land here, permanently and correctly.
          return refuse('no-base-url')
        }
        cachedBaseUrl = raw
      }

      const base = parseAdminBase(cachedBaseUrl)
      if (!base.ok) {
        cachedBaseUrl = null
        return refuse('base-unusable', { baseReason: base.reason })
      }

      const page = pageFor(subject, base.basePath)
      if (page === null) return refuse('empty-subject')

      const built = buildDeviceAdminUrl({
        host: base.host,
        port: base.port,
        scheme: base.scheme,
        path: page.path,
        ...(page.query !== undefined ? { query: page.query } : {}),
      })
      if (!built.ok) return refuse('build-refused', { buildReason: built.reason })

      return {
        url: built.url,
        label: 'Home Assistant',
        target: 'integration',
        host: base.host,
      }
    },
  }

  ctx.registerNativeCap(deviceAdminLinkCapability, provider)
}
