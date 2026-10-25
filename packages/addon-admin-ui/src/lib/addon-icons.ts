/**
 * Which addon icon URLs can EXIST — derived from the manifests the hub
 * reports, never guessed from an id.
 *
 * The admin UI used to build `/api/addon-assets/<id>/assets/icon.svg` for any
 * id it held, and `ProviderIcon` went further: it prefixed `provider-` to
 * every id that lacked it. A device owned by `core-blocks`, `camera-grid`,
 * `terminal` or `pipeline-analytics` therefore asked for
 * `/api/addon-assets/provider-core-blocks/assets/icon.svg` — an addon that
 * does not exist — and the console filled with 404s before the `<img>` fell
 * back to its glyph.
 *
 * The rule now: an icon URL is produced only for an addon whose manifest
 * declares an `icon` asset path; every other caller gets `null` and draws its
 * glyph without a request.
 */

import { hubPath } from './mount'

/** An addon-level `icon` is an asset PATH; a bare word ("gauge") is a glyph name for a page/widget. */
const ASSET_EXTENSIONS = /\.(svg|png|jpe?g|webp)$/i

const PROVIDER_PREFIX = 'provider-'

interface RawAddonEntry {
  readonly manifest?: { readonly id?: unknown; readonly icon?: unknown }
  readonly declaration?: { readonly icon?: unknown } | null
}

export function isAddonIconAssetPath(icon: unknown): icon is string {
  return typeof icon === 'string' && ASSET_EXTENSIONS.test(icon) && !icon.includes('..')
}

/** `addons.list` → `addonId → declared icon asset path`, for the addons that declare one. */
export function buildAddonIconMap(
  addons: readonly unknown[] | undefined,
): ReadonlyMap<string, string> {
  const entries: [string, string][] = []
  for (const raw of addons ?? []) {
    const entry = raw as RawAddonEntry | null
    const id = entry?.manifest?.id
    if (typeof id !== 'string' || id.length === 0) continue
    const icon = entry?.declaration?.icon ?? entry?.manifest?.icon
    if (isAddonIconAssetPath(icon)) entries.push([id, icon])
  }
  return new Map(entries)
}

/**
 * The mount-aware asset URL for an addon hint, or `null` when no declared icon
 * matches. The hint is an addon id; a bare provider name (`'reolink'`, as the
 * Showroom and some device records carry) also resolves to its
 * `provider-<name>` addon — but only when that addon is actually known.
 */
export function resolveAddonIconPath(
  icons: ReadonlyMap<string, string>,
  hint: string | null | undefined,
): string | null {
  if (!hint) return null
  const candidates = hint.startsWith(PROVIDER_PREFIX) ? [hint] : [hint, `${PROVIDER_PREFIX}${hint}`]
  for (const id of candidates) {
    const icon = icons.get(id)
    if (icon) return hubPath(`/api/addon-assets/${encodeURIComponent(id)}/${icon}`)
  }
  return null
}
