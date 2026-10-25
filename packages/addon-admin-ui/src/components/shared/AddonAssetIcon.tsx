import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useAddonIconUrl } from '../../contexts/addon-icons-context'

interface AddonAssetIconProps {
  /** Addon id whose manifest-declared `icon` is drawn (see `useAddonIconUrl`). */
  readonly addonId: string
  /** Lucide fallback when the addon declares no icon, or its asset fails to load. */
  readonly fallback: LucideIcon
  /** Tile background classes — typically a coloured tint matched to status. */
  readonly tileClassName: string
  /**
   * `md` (default) is the 40 px tile a list row carries; `sm` is the 20 px
   * mark an integration pill carries next to its name.
   */
  readonly size?: 'md' | 'sm'
}

const SIZE_CLASSES = {
  md: { tile: 'h-10 w-10 rounded-lg', img: 'h-7 w-7 rounded-md p-1', fallback: 'h-5 w-5' },
  sm: { tile: 'h-5 w-5 rounded', img: 'h-5 w-5 rounded p-0.5', fallback: 'h-3.5 w-3.5' },
} as const

/**
 * Renders the addon-shipped icon served by `/api/addon-assets/...` — only
 * when the addon's manifest DECLARES one (`useAddonIconUrl`); an addon that
 * declares none draws the Lucide glyph and makes no request.
 *
 * Two key bits of state are local to the component:
 *   • `iconBroken` — flips when a declared asset still fails to load
 *     (e.g. `files: ["dist"]` left `assets/` out of the tarball);
 *     subsequent renders use the fallback glyph instead of retrying.
 *   • Container styling — `size` picks the 40 px row tile or the 20 px
 *     pill mark. Callers can pass a different `tileClassName` to tint
 *     the background.
 *
 * Brand-icon contrast: addon `assets/icon.svg` files are official
 * single-colour brand glyphs with a fixed hex baked into the path
 * (Tailscale `#242424`, MQTT `#660066`, …). On a dark
 * status tile those near-black marks were almost invisible. The brand
 * `<img>` is therefore rendered on its own constant WHITE chip — the
 * universal "logo on a tile" treatment — so every brand colour stays
 * legible in both light and dark mode. The Lucide fallback keeps using
 * the tinted tile directly (it paints with `currentColor`, so it
 * already adapts to the theme).
 */
export function AddonAssetIcon({
  addonId,
  fallback: Fallback,
  tileClassName,
  size = 'md',
}: AddonAssetIconProps): React.ReactElement {
  const [iconBroken, setIconBroken] = useState(false)
  const assetUrl = useAddonIconUrl(addonId)
  const classes = SIZE_CLASSES[size]
  return (
    <div className={`${classes.tile} flex items-center justify-center shrink-0 ${tileClassName}`}>
      {iconBroken || !assetUrl ? (
        <Fallback className={classes.fallback} aria-hidden />
      ) : (
        // Decorative: every caller names the addon in text right beside it.
        <img
          src={assetUrl}
          alt=""
          className={`${classes.img} bg-white ring-1 ring-black/5`}
          onError={() => setIconBroken(true)}
        />
      )}
    </div>
  )
}
