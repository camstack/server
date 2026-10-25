/**
 * frame-policy — who may put a hub page inside an `<iframe>`.
 *
 * Answer: the hub's own origin, and nobody else (D425). Before this the hub
 * sent neither `X-Frame-Options` nor a `frame-ancestors` directive (verified
 * on the live hub, 2026-09-09), so any site could frame the admin UI, the
 * login page or the viewer. That was never a working embed — the session
 * cookie is `SameSite=Lax` and does not travel into a cross-site frame, so a
 * page framed from elsewhere loaded and then failed on every cookie-gated
 * request — but it was a clickjacking surface, and one that a future
 * "make the iframe work" change would have been tempted to widen with
 * `SameSite=None`.
 *
 * Same-origin framing is the ONLY shape the hub supports, and it covers every
 * real embed:
 *
 *  - the admin UI frames the viewer (`/viewer`), same origin by construction;
 *  - Home Assistant frames the admin UI and the viewer's embed through a
 *    relay on ITS OWN origin (`https://<ha>/api/camstack/p/<grant>/…`, see
 *    `spa-mount.ts`). The relay forwards this header unchanged and the
 *    browser evaluates `'self'` against the document's origin — Home
 *    Assistant's — so the relayed frame is allowed exactly because it is
 *    same-origin from where the browser stands;
 *  - a top-level window (the desktop shell, a native WebView, a share link)
 *    has no ancestor and is never affected.
 *
 * The policy is stamped at the RESPONSE layer, on every HTML document, rather
 * than at each shell-send site: the cache policy once drifted because a second
 * send site shipped bare (`spa-shell-cache-headers.spec.ts`), and a framing
 * policy that depends on every future route remembering it is the same trap.
 * A route that states its own `Content-Security-Policy` keeps it.
 */
import type { FastifyInstance } from 'fastify'

/** The one directive: frame me from my origin only. */
export const FRAME_ANCESTORS_POLICY = "frame-ancestors 'self'"

const CSP_HEADER = 'content-security-policy'

/** Only a document can be framed; assets, JSON and streams are never one. */
export function isFramePolicyTarget(contentType: unknown): boolean {
  return typeof contentType === 'string' && contentType.trim().toLowerCase().startsWith('text/html')
}

/**
 * Install the `onSend` hook on the hub's one Fastify instance. Replies that
 * bypass Fastify's reply pipeline (`reply.raw`, `reply.hijack()` — the addon
 * reverse proxy's streaming path) are not seen here; they carry no HTML
 * shell of ours.
 */
export function registerFramePolicy(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    if (!isFramePolicyTarget(reply.getHeader('content-type'))) return payload
    if (reply.getHeader(CSP_HEADER) !== undefined) return payload
    reply.header(CSP_HEADER, FRAME_ANCESTORS_POLICY)
    return payload
  })
}
