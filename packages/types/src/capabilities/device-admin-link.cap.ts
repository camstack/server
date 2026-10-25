/**
 * device-admin-link — "this device has a management page of its own, and here
 * is its address".
 *
 * ## Why this is not a `deviceConfig` cap
 *
 * There is nothing to edit. A `deviceConfig` cap (D14) exists so the framework
 * can DERIVE a settings form from `getOptions` + `getStatus` and route a flat
 * patch back through a setter; it costs a `builderId` reducer in
 * `device-config-contribution.ts` and a `*-config-schema.ts` beside it, and it
 * renders a form section. This cap answers ONE question with ONE read and
 * renders a button. Nothing about it is a form, so it carries no `deviceConfig`
 * block, no `settings`, no `runtimeState` and no reducer — exactly like
 * `reboot`, the other pure-RPC device-native cap.
 *
 * ## Absent, and the difference between "no page" and "we cannot say"
 *
 * The two are answered at DIFFERENT layers, on purpose:
 *
 *  - **"We cannot say"** → the provider never registers the cap for that
 *    device. A VeSync humidifier, a Petkit feeder, a Dreame vacuum and a Dreo
 *    fan are reached only through a vendor cloud; there is no address to hand
 *    out and no page to open. A Tuya plug, a Wyze camera and a Gree air
 *    conditioner DO have a LAN IP, and still have no HTTP management page
 *    behind it. None of them register, so `deviceManager.getBindings` never
 *    lists the cap and no surface asks.
 *  - **"This device has no page, and I know that"** → the provider registers
 *    and `getAdminLink` returns `null`. This is the answer for a device whose
 *    sibling DOES have a page: a Reolink battery camera reached over UDP by
 *    `uid` with a blank `host`, an Ecowitt gateway configured in `listener`
 *    transport, a Home Assistant broker authenticated by supervisor token
 *    (which carries no `baseUrl` at all).
 *
 * Both draw NOTHING. A button that opens a browser error is worse than no
 * button, and D62 is the same rule from the other side: an off switch is
 * reported off, never made to look broken. There is no third state where the
 * UI renders a disabled button "because the device might have a page".
 *
 * ## The URL never carries credentials
 *
 * Not in userinfo, not in a query string. Every provider builds through
 * `buildDeviceAdminUrl` (`device-admin-link-url.ts`), which takes host, port,
 * scheme and path as separate arguments — there is no parameter a secret could
 * arrive in — and re-checks its own output for the `scheme://user:pass@` shape
 * that `scripts/check-no-credential-urls-in-fixtures.ts` bans from recorded
 * output. `scripts/check-admin-link-builder-is-the-only-url-source.ts` is what
 * keeps providers from hand-rolling one anyway.
 *
 * This matters here more than anywhere else in the repo, because every provider
 * that knows a device's host knows its PASSWORD too: `{ host, port, username,
 * password }` sit in one object on Hikvision, Amcrest, Reolink and ONVIF alike,
 * and `http://admin:hunter2@192.168.60.139/` is a URL a browser accepts. The
 * camera's own page will ask for its own login. That is correct, and pre-
 * filling it is the operator's business, not ours.
 *
 * ## It is a LAN fact
 *
 * The URL addresses the device where the NODE can see it. It is not proxied,
 * not made reachable from outside, and not sent anywhere. A surface renders it
 * as a link the operator's own browser follows, on the operator's own network,
 * or renders nothing.
 */
import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * Whose page is it. The distinction is for the OPERATOR, who needs to know
 * before clicking whether he is about to land on a camera's own web server or
 * inside Home Assistant.
 */
export const AdminLinkTargetEnum = z.enum([
  /** A web server running on the device itself (a camera's config page). */
  'device',
  /**
   * A page in the upstream system that manages the device — the Home Assistant
   * device page, the UniFi controller, the Homematic CCU. The device has no web
   * server of its own; the system that owns it does.
   */
  'integration',
])
export type AdminLinkTarget = z.infer<typeof AdminLinkTargetEnum>

export const DeviceAdminLinkSchema = z.object({
  /**
   * Absolute `http(s)://` URL. Built by `buildDeviceAdminUrl` and therefore
   * free of userinfo and of any credential-shaped query key.
   */
  url: z.string(),
  /**
   * What the surface calls it — "Web UI", "Home Assistant", "UniFi controller".
   * The PROVIDER names it, because only the provider knows what the page is;
   * a UI that invented the label from the addon id would call the Home
   * Assistant device page "Provider Homeassistant".
   */
  label: z.string(),
  target: AdminLinkTargetEnum,
  /**
   * Host the URL points at, without scheme, port or path — for the tooltip, so
   * an operator can see WHERE the button goes before he follows it. Redundant
   * with `url` by construction; carried separately so no surface has to parse
   * a URL to show it.
   */
  host: z.string(),
})
export type DeviceAdminLink = z.infer<typeof DeviceAdminLinkSchema>

export const deviceAdminLinkCapability = {
  name: 'device-admin-link',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // No `deviceTypes`: a camera, an NVR, a server and a home-automation hub all
  // have management pages. Restricting the list here would be a guess about
  // vendors that do not exist yet.
  methods: {
    /**
     * The device's management page, or `null` when this device has none.
     *
     * `auth: 'admin'` deliberately. This is administration, not actuation —
     * the same bucket as `reboot` and `camera-credentials`, and explicitly NOT
     * the actuation set `scripts/check-actuation-not-admin.ts` protects (D403).
     * The URL is also a statement about the LAN, which a household member with
     * a `view` grant on a light has no reason to be handed.
     *
     * The surfaces gate on the QUERY, never on a role they guessed: a caller
     * without the right loses the query and draws nothing, which is the same
     * thing a device with no page draws. There is no path on which a button
     * appears and then fails — the D403 failure mode, from the other end.
     */
    getAdminLink: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      DeviceAdminLinkSchema.nullable(),
      { auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IDeviceAdminLinkProvider = InferProvider<typeof deviceAdminLinkCapability>
