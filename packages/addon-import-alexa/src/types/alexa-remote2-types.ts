/**
 * Hand-written ambient types for the RESPONSE-BODY subset of `alexa-remote2`
 * that the addon consumes.
 *
 * Why this file exists (and what it deliberately does NOT do):
 *
 *  - `alexa-remote2` v8 DOES ship a `module "alexa-remote2"` declaration
 *    (`alexa-remote.d.ts`) covering the `AlexaRemote` CLASS surface — the
 *    constructor, `init`, `getSmarthomeDevicesV2`, `querySmarthomeDevices`,
 *    `executeSmarthomeDeviceAction`, `stop`, `getAuthenticationDetails`, the
 *    `EventEmitter` `on(...)`, etc. The real binding imports the class normally
 *    and relies on those shipped types, so NO cast is needed to call the API.
 *  - We therefore only AUGMENT that module (declaration-merging), never redeclare
 *    its class — redeclaring it would duplicate-identify and break `tsc`.
 *  - What the shipped types leave OPEN is the callback BODY: every data method is
 *    `(err?: Error, body?: T) => void`, i.e. the payload arrives effectively as
 *    `unknown`. This file gives names to the exact JSON SHAPES we read out of
 *    those bodies, so the runtime decoders (`alexa-remote-decode.ts`) can be
 *    written against named types and validated with Zod at the boundary —
 *    keeping the binding strictly typed and cast-free.
 *
 * It is a regular `.ts` module (the repo `.gitignore` excludes hand-written
 * `.d.ts` files under each package src tree) carrying ONLY ambient declarations:
 * the `declare global` interfaces are visible across the addon's src without an
 * import, and the file produces no runtime output (tree-shaken from the bundle).
 *
 * It ALSO augments the shipped class with corrected overloads: the shipped
 * `executeSmarthomeDeviceAction` types `parameters` as `string[]` (the Phoenix
 * control wire-format actually needs a single `{ action, ... }` object), and
 * `init` is widened to accept the persisted `cookieData` registration OBJECT as
 * its `cookie`. Class + interface declaration-merging adds these without a cast,
 * leaving the shipped overloads intact.
 */

import 'alexa-remote2'

declare module 'alexa-remote2' {
  export default interface AlexaRemote {
    executeSmarthomeDeviceAction(
      entityIds: string[],
      parameters: AlexaRemoteControlParameters,
      entityType: 'APPLIANCE' | 'GROUP',
      callback: (err?: Error, body?: unknown) => void,
    ): void

    /**
     * Overload: the shipped `InitOptions.cookie` is typed `string`, but the lib
     * accepts the persisted `cookieData` registration OBJECT as the `cookie`
     * field at runtime (README: "store alexa.cookieData and provide this object
     * as options.cookie"). This object-init overload reflects that.
     */
    init(options: AlexaRemoteInitOptions, callback: (err?: Error) => void): void
  }
}

declare global {
  /** Correct Alexa Phoenix control parameter shape (`{ action, ...args }`). */
  interface AlexaRemoteControlParameters {
    readonly action: string
    readonly [key: string]: unknown
  }

  /**
   * `init` options we set. `cookie` accepts either a cookie STRING or the
   * persisted `cookieData` registration OBJECT (the lib unpacks both). Kept
   * minimal — only fields the binding sets.
   *
   * Proxy-login fields (`proxyOwnIp` / `proxyPort` / `proxyLogLevel`) are set
   * ONLY when starting an interactive cookie capture (`proxyOnly:true` with NO
   * `cookie`): alexa-remote2 spins a local Express reverse-proxy to Amazon's
   * login page, captures the cookie/`cookieData`, and emits the `cookie` event.
   * `proxyOwnIp` MUST equal the host:port the operator's browser uses to reach
   * the proxy (alexa-cookie2 rewrites every Amazon URL to
   * `http://<proxyOwnIp>:<proxyPort>/...`), so it is a directly-reachable host
   * (the hub LAN IP), NOT behind the hub's HTTPS data-plane sub-path.
   */
  interface AlexaRemoteInitOptions {
    /** Required: unset, the bundled library reads a package.json that is not shipped. */
    readonly apiUserAgentPostfix: string
    readonly cookie?: string | object
    readonly amazonPage?: string
    readonly proxyOnly?: boolean
    readonly proxyOwnIp?: string
    readonly proxyPort?: number
    readonly proxyLogLevel?: string
    readonly logger?: (...args: unknown[]) => void
  }

  /**
   * One Alexa capability the appliance reports. The Phoenix model nests these
   * under `legacyAppliance.capabilities`; only `interfaceName` is load-bearing
   * for the cap mapping.
   */
  interface AlexaRemoteCapability {
    readonly interfaceName?: string
    readonly type?: string
    readonly version?: string
  }

  /**
   * The legacy appliance descriptor carried inside each smart-home endpoint
   * (`getSmarthomeDevicesV2().items[].legacyAppliance`). All fields are optional
   * because Amazon omits them per-appliance and we never trust their presence.
   */
  interface AlexaRemoteLegacyAppliance {
    readonly applianceId?: string
    readonly entityId?: string
    readonly friendlyName?: string
    readonly manufacturerName?: string
    readonly applianceNetworkState?: string
    readonly capabilities?: ReadonlyArray<AlexaRemoteCapability | string>
    readonly applianceTypes?: ReadonlyArray<string>
  }

  /** One endpoint item returned by `getSmarthomeDevicesV2`. */
  interface AlexaRemoteEndpointItem {
    readonly endpointId?: string
    readonly id?: string
    readonly friendlyName?: string
    readonly legacyAppliance?: AlexaRemoteLegacyAppliance
  }

  /**
   * One entity from `getSmarthomeEntities` (`/api/behaviors/entities`). Used to
   * recover the Alexa group / room a device sits in (→ CamStack location).
   */
  interface AlexaRemoteBehaviorEntity {
    readonly id?: string
    readonly entityId?: string
    readonly displayName?: string
    readonly entityType?: string
    readonly groupType?: string
  }

  /**
   * A single capability-state datum returned by `querySmarthomeDevices`. The
   * Phoenix `/api/phoenix/state` endpoint encodes each as a JSON STRING that
   * decodes to `{ namespace, name, value, ... }` (the inverse of the exporter's
   * report-state property shape).
   */
  interface AlexaRemoteCapabilityState {
    readonly namespace?: string
    readonly name?: string
    readonly value?: unknown
    readonly instance?: string
  }

  /** One device's polled state (`querySmarthomeDevices().deviceStates[]`). */
  interface AlexaRemoteDeviceState {
    readonly entity?: { readonly entityId?: string; readonly entityType?: string }
    /** Each entry is a JSON-encoded {@link AlexaRemoteCapabilityState}. */
    readonly capabilityStates?: ReadonlyArray<string>
  }

  /** One error entry in a Phoenix state response. */
  interface AlexaRemoteStateError {
    readonly code?: string
    readonly entity?: { readonly entityId?: string }
    readonly message?: string | null
  }

  /** The full `querySmarthomeDevices` response body. */
  interface AlexaRemoteQueryResult {
    readonly deviceStates?: ReadonlyArray<AlexaRemoteDeviceState>
    readonly errors?: ReadonlyArray<AlexaRemoteStateError>
  }
}
