/**
 * Where the hub is, for the admin UI.
 *
 * The admin UI can be served under a path prefix decided at runtime by a
 * reverse proxy (the Home Assistant relay, `/api/camstack/p/<grant>/…` →
 * hub `/…`). The hub injects `<base href>` + `<meta name="camstack-mount">`
 * into the shell it serves for such a request, and this is the admin UI's
 * one door to that fact. The implementation lives in `@camstack/ui-library`
 * (`lib/hub-mount.ts`) because the library's own composites — the snapshot
 * hook, the scene gallery, the MF remote loader — compose hub URLs too, and
 * two readers of one `<base>` would be one reader too many.
 *
 *   hubPath('/api/x')   same-origin path under the mount (fetch, <img>, links)
 *   hubOrigin()         absolute base, no trailing slash — the SDK `serverUrl`
 *   hubUrl / hubWsUrl   absolute http(s) / ws(s) forms
 *   routerBasename()    for <BrowserRouter basename>
 *
 * `scripts/check-hub-paths-through-mount.ts` fails the build on a hub path
 * spelled anywhere else.
 */
export {
  hubOrigin,
  hubPath,
  hubUrl,
  hubWsUrl,
  mountPath,
  routerBasename,
} from '@camstack/ui-library'
