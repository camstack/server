/**
 * The integration instance of an addon, as it appears in an address or on an
 * OAuth link (planning#415, D1046).
 *
 * The DEFAULT instance has two spellings on the wire and one in the code: a
 * path with no instance segment and a link with no instance both mean it, and
 * its id is the addon id. Everything that compares instances goes through
 * {@link oauthLinkServesInstance}, so nobody compares `undefined` with an id.
 */

/** An instance id as it may appear in a path or a query: no separator, no escape, bounded. */
const ADDON_INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export function isAddonInstanceId(value: string): boolean {
  return ADDON_INSTANCE_ID_RE.test(value)
}

/** What a verified OAuth link says about its instance: the id, or nothing for the default one. */
export interface OauthLinkInstance {
  readonly instanceId?: string | null
}

/** The instance a link was made for, with the default one spelled as the addon id. */
export function oauthLinkInstanceId(link: OauthLinkInstance, addonId: string): string {
  return link.instanceId ?? addonId
}

/**
 * True when a verified link may be used on a request addressed to
 * `requestInstanceId` (`AddonHttpRequest.instanceId`, absent on a route that
 * is not per-instance, which is the default instance).
 */
export function oauthLinkServesInstance(
  link: OauthLinkInstance,
  requestInstanceId: string | undefined,
  addonId: string,
): boolean {
  return oauthLinkInstanceId(link, addonId) === (requestInstanceId ?? addonId)
}
