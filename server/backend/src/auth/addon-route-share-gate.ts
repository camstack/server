/**
 * The data-plane gate's answer to a share-link token.
 *
 * A share link is a bearer credential for ONE view of a FEW devices, not a
 * session: the hub's tRPC layer already confines it to a fail-closed method
 * list per scope kind (`share-view-access.ts`). The data planes are reached
 * outside tRPC, and until this module the gate resolved session JWTs and
 * scoped tokens only — so the events embed under a share link listed its events
 * and got 401 on every thumbnail (`EVENTS-EMBED.md` §7).
 *
 * Two rules. The first lives in the one scope matcher
 * (`authorizeAddonRoute`, D892): a plane serves a share principal only when it
 * OPTED IN to that kind (`AddonDataPlaneServeOptions.share`) — a plane that
 * never reads the scope would otherwise serve every device to a link scoped to
 * two. The second is here: the scope's devices reach the plane in headers the
 * HUB sets after validation, and whatever the client sent under those names is
 * stripped first — the gate is the only writer.
 */
export const SHARE_KIND_HEADER = 'x-camstack-share-kind'
export const SHARE_DEVICES_HEADER = 'x-camstack-share-devices'

/** The forwarded header set without any share header the client supplied. */
export function stripShareHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === SHARE_KIND_HEADER || lower === SHARE_DEVICES_HEADER) continue
    out[key] = value
  }
  return out
}
