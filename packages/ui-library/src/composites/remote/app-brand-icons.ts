/**
 * The app-brand icon registry of a remote layout button. A button that opens a
 * streaming app wears `icon: "app:<key>"`; this is the ONE place that turns
 * the key into something drawable, shared by the editor's picker and by every
 * renderer of a layout (`RemoteGrid`). A key that is not here is not an app
 * icon — the caller falls back to the display-icon path.
 *
 * The marks are data: the SVG path of a brand glyph from `simple-icons`
 * (CC0, version pinned in package.json, named imports so a bundler keeps only
 * these), or a lettermark for a brand that package does not carry.
 *
 * A glyph carries its brand colour (`hex`, the package's own data — no colour
 * literal lives in this repository). That is a deliberate exception to the
 * token-only rule: a brand mark is the brand's, not the product's. It is drawn
 * in that colour only where it reads on BOTH themes (`brandFill`); a mark too
 * dark or too light for one of them — a black or a white logo — falls back to
 * the surrounding text colour, which the theme already keeps legible.
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
  | { readonly kind: 'glyph'; readonly path: string; readonly hex: string }
  | { readonly kind: 'lettermark'; readonly text: string }

export interface AppBrand {
  /** The slug after `app:`. */
  readonly key: string
  /** The brand's own name — a proper noun, never translated. */
  readonly label: string
  readonly mark: AppBrandMark
}

const glyph = (
  key: string,
  label: string,
  icon: { readonly path: string; readonly hex: string },
): AppBrand => ({
  key,
  label,
  mark: { kind: 'glyph', path: icon.path, hex: icon.hex },
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

/** WCAG relative luminance (0 black .. 1 white) of a `RRGGBB` hex, or null when it is not one. */
export function relativeLuminance(hex: string): number | null {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** Luminance of the dark and the light theme's button surface (`surface` tokens), rounded. */
const DARK_SURFACE_LUMINANCE = 0.011
const LIGHT_SURFACE_LUMINANCE = 0.91
/** The least contrast ratio a brand colour needs against BOTH surfaces. */
const MIN_BRAND_CONTRAST = 2.2

function contrastRatio(a: number, b: number): number {
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

/**
 * The CSS colour to draw a glyph in: its brand colour when that colour keeps
 * at least `MIN_BRAND_CONTRAST` against the dark and the light surface, else
 * null — the caller then uses the surrounding text colour.
 */
export function brandFill(mark: AppBrandMark): string | null {
  if (mark.kind !== 'glyph') return null
  const luminance = relativeLuminance(mark.hex)
  if (luminance === null) return null
  const legible =
    contrastRatio(luminance, DARK_SURFACE_LUMINANCE) >= MIN_BRAND_CONTRAST &&
    contrastRatio(luminance, LIGHT_SURFACE_LUMINANCE) >= MIN_BRAND_CONTRAST
  return legible ? `#${mark.hex}` : null
}
