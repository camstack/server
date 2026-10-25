/**
 * Rebuild the concrete request path from a route pattern and the params the
 * hub already matched (`/:providerId/start` + `{providerId:'authentik'}` →
 * `/authentik/start`).
 *
 * The forked-addon bridge forwards a request to the child's
 * `buildAddonRouteProvider().invoke`, which matches the path again to pick the
 * route and extract params. Sending it the PATTERN made that second match bind
 * every param to its own placeholder (`providerId = ':providerId'`), which
 * overwrote the real value — every parameterized route of a forked addon saw
 * literal `:name` params.
 */
export function materializeRoutePath(
  pattern: string,
  params: Readonly<Record<string, string>>,
): string {
  return pattern
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part
      const value = params[part.slice(1)]
      return value === undefined ? part : encodeURIComponent(value)
    })
    .join('/')
}
