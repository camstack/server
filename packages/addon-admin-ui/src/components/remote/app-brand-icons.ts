/**
 * The app-brand icon registry of a remote layout button. A button that opens a
 * streaming app wears `icon: "app:<key>"`; this is the ONE place that turns
 * the key into something drawable, shared by the editor's picker and by every
 * renderer of a layout (`RemoteGrid`). A key that is not here is not an app
 * icon — the caller falls back to the display-icon path.
 *
 * The marks are data: the SVG path of a brand glyph from `simple-icons`
 * (CC0, version pinned in package.json, named imports so a bundler keeps only
 * these), or a lettermark for a brand that package does not carry. Every mark
 * is drawn in the surrounding text colour: a brand colour would vanish on one
 * of the two themes, so no colour is stored here.
 */
import {
  siApplemusic,
  siAppletv,
  siCrunchyroll,
  siDazn,
  siKodi,
  siMax,
  siNetflix,
  siNow,
  siParamountplus,
  siPlex,
  siSky,
  siSpotify,
  siTwitch,
  siYoutube,
  siYoutubemusic,
} from 'simple-icons'

export const APP_ICON_PREFIX = 'app:'

export type AppBrandMark =
  | { readonly kind: 'glyph'; readonly path: string }
  | { readonly kind: 'lettermark'; readonly text: string }

export interface AppBrand {
  /** The slug after `app:`. */
  readonly key: string
  /** The brand's own name — a proper noun, never translated. */
  readonly label: string
  readonly mark: AppBrandMark
}

const glyph = (key: string, label: string, icon: { readonly path: string }): AppBrand => ({
  key,
  label,
  mark: { kind: 'glyph', path: icon.path },
})
const lettermark = (key: string, label: string, text: string): AppBrand => ({
  key,
  label,
  mark: { kind: 'lettermark', text },
})

export const APP_BRANDS: readonly AppBrand[] = [
  glyph('netflix', 'Netflix', siNetflix),
  glyph('youtube', 'YouTube', siYoutube),
  lettermark('primevideo', 'Prime Video', 'prime'),
  lettermark('disneyplus', 'Disney+', 'D+'),
  glyph('spotify', 'Spotify', siSpotify),
  glyph('plex', 'Plex', siPlex),
  glyph('appletv', 'Apple TV', siAppletv),
  glyph('dazn', 'DAZN', siDazn),
  lettermark('raiplay', 'RaiPlay', 'Rai'),
  lettermark('mediasetinfinity', 'Mediaset Infinity', 'MI'),
  glyph('now', 'NOW', siNow),
  glyph('twitch', 'Twitch', siTwitch),
  glyph('max', 'Max', siMax),
  glyph('paramountplus', 'Paramount+', siParamountplus),
  glyph('crunchyroll', 'Crunchyroll', siCrunchyroll),
  glyph('sky', 'Sky', siSky),
  glyph('youtubemusic', 'YouTube Music', siYoutubemusic),
  glyph('applemusic', 'Apple Music', siApplemusic),
  glyph('kodi', 'Kodi', siKodi),
]

const BY_KEY: ReadonlyMap<string, AppBrand> = new Map(APP_BRANDS.map((b) => [b.key, b]))

export function appIconKey(brandKey: string): string {
  return `${APP_ICON_PREFIX}${brandKey}`
}

/** The brand an `icon` value names, or undefined when it is not an `app:` key of the registry. */
export function resolveAppBrand(icon: string | undefined): AppBrand | undefined {
  if (icon === undefined || !icon.startsWith(APP_ICON_PREFIX)) return undefined
  return BY_KEY.get(icon.slice(APP_ICON_PREFIX.length))
}
