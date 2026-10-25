/**
 * viewer-embed — whether, and where, the admin UI frames the viewer.
 *
 * The viewer is served by the hub itself at `/viewer/camstack/` (the
 * pipeline-orchestrator's `viewer-ui` provider), so from the admin UI it is a
 * same-origin document: the `camstack_session` cookie reaches the frame, the
 * viewer's own `auth.exchangeSession` bootstrap turns it into a bearer, and
 * nothing is injected across the boundary. That is the only shape the hub
 * frames in — every HTML document it serves says `frame-ancestors 'self'`
 * (D425) — and it is exactly the shape the desktop shell relies on too.
 *
 * Under a MOUNT PREFIX the frame is refused here, deliberately. The Home
 * Assistant relay serves the admin UI at `/api/camstack/p/<grant>/…`, and
 * the admin UI survives that because it composes every hub URL through
 * `hubPath` (D373). The viewer does not: it is an Expo export whose base
 * path is baked in at build time, so its shell asks for
 * `/viewer/camstack/_expo/…` root-absolute and its router strips a fixed
 * `/viewer/camstack` off the pathname. Framed through the relay it is a page
 * of 404s on the relay's origin — a white rectangle with no error, which is
 * worse than a sentence. When the viewer learns the mount the way the admin
 * UI did, this is the one branch to flip.
 */
import { hubPath, routerBasename } from './mount'

export type ViewerEmbedPlan =
  | { readonly kind: 'frame'; readonly src: string }
  | { readonly kind: 'unavailable-under-mount'; readonly mount: string }

/**
 * Decide the frame from the mount the shell declared. `basename` is the
 * router basename (`''` at the root, `/api/camstack/p/<grant>` under the
 * relay) — injectable so the rule is testable without a document.
 */
export function planViewerEmbed(basename: string = routerBasename()): ViewerEmbedPlan {
  if (basename === '') return { kind: 'frame', src: hubPath('/viewer/camstack/') }
  return { kind: 'unavailable-under-mount', mount: basename }
}
