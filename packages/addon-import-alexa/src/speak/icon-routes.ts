/**
 * Serves the Alexa brand mark for the `alexa-echo` target kind, the same way
 * the notifiers addon serves its kinds' icons: one public GET route on the
 * addon's own `addon-routes` surface, and `listTargetKinds` stamps the matching
 * `iconUrl` (`ALEXA_SPEAK_ICON_URL`). The bytes ship inside the addon.
 *
 * The mark is `assets/alexa-echo.svg` (simple-icons, CC0; see the licence note
 * beside it). It is embedded here because the addon bundle carries no asset
 * directory; a spec fails if the two copies differ. It stays under 1 KiB on
 * purpose: the hub's response compressor returns an empty body for a larger
 * compressible response that crosses the route bridge of a forked addon.
 */
import type { IAddonHttpRoute } from '@camstack/types'
import { ALEXA_SPEAK_KIND } from './constants.js'

export const ALEXA_ICON_SVG =
  '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#00CAFF"><title>Amazon Alexa</title><path d="M12 0C5.37 0 0 5.37 0 12C0 18.09 4.53 23.11 10.4 23.9V21.5A1.59 1.59 0 0 0 9.32 19.97A8.41 8.41 0 0 1 3.6 11.8A8.37 8.37 0 0 1 12.09 3.6A8.4 8.4 0 0 1 20.4 12.31L20.39 12.38A8.68 8.68 0 0 1 20.36 12.76C20.36 12.83 20.35 12.9 20.34 12.96C20.34 13.04 20.33 13.12 20.32 13.19L20.3 13.29C19.27 20.07 10.45 23.87 10.4 23.9C10.92 23.97 11.46 24 12 24C18.63 24 24 18.63 24 12S18.63 0 12 0Z"/></svg>'

/** One day; the mark is immutable per addon version. */
const CACHE_CONTROL = 'public, max-age=86400, immutable'

export function speakIconRoutes(): readonly IAddonHttpRoute[] {
  return [
    {
      method: 'GET',
      path: `/icons/${ALEXA_SPEAK_KIND}`,
      access: 'public',
      description: 'Alexa brand mark (image/svg+xml) for the Alexa notification target.',
      handler: async (_request, reply) => {
        reply
          .code(200)
          .type('image/svg+xml')
          .header('cache-control', CACHE_CONTROL)
          .send(ALEXA_ICON_SVG)
      },
    },
  ]
}
