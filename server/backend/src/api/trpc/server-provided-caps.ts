/**
 * The capabilities the SERVER provides — routers mounted from
 * `buildServerProviders` (`trpc.router.ts`) rather than from an addon.
 *
 * One list, two consumers, so they cannot drift:
 *  - `buildServerProviders` is typed over {@link ServerProvidedCapName}: a
 *    factory added there without a name here, or a name here without a
 *    factory, is a compile error.
 *  - the `$core-caps` mesh bridge (`core-cap-bridge.ts`) derives its
 *    namespace set from {@link HUB_SERVICE_CAP_NAMES}. Before it did, the
 *    inference-timeout guard's first fingerprint failed on all three nodes
 *    with "no provider registered for cap server-management" — the server
 *    provided the cap, no addon did, and the bridge list had been copied by
 *    hand before the cap existed.
 */

/**
 * Caps served by a hub SERVICE. No addon ever registers a provider for them,
 * so a forked runner can reach them only over the `$core-caps` bridge.
 */
export const HUB_SERVICE_CAP_NAMES = [
  'network-quality',
  'system',
  'toast',
  'integrations',
  'nodes',
  'server-management',
  'addons',
] as const

/**
 * Caps whose server factory only WRAPS an addon singleton per request
 * (`webrtc-session` injects the HTTP User-Agent the forked broker cannot
 * see). A forked caller resolves these through the registry like any addon
 * cap; a resolver miss means the addon is down, not that the bridge should
 * answer — so they are deliberately NOT bridged.
 */
export const ADDON_BACKED_SERVER_CAP_NAMES = ['webrtc-session'] as const

export type HubServiceCapName = (typeof HUB_SERVICE_CAP_NAMES)[number]
export type AddonBackedServerCapName = (typeof ADDON_BACKED_SERVER_CAP_NAMES)[number]
export type ServerProvidedCapName = HubServiceCapName | AddonBackedServerCapName

/** kebab-case cap name → the camelCase appRouter namespace it is mounted as. */
export function capNameToNamespace(capName: string): string {
  return capName.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
}
