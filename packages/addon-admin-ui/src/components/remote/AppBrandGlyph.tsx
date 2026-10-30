/**
 * Draws one app brand from the registry: the glyph in its brand colour where
 * that reads on both themes (`brandFill`), else in the surrounding text
 * colour; or the lettermark when the glyph set has none.
 */
import type { ReactNode } from 'react'
import { type AppBrand, brandFill } from './app-brand-icons'

export function AppBrandGlyph({ brand }: { readonly brand: AppBrand }): ReactNode {
  if (brand.mark.kind === 'lettermark') {
    return (
      <span className="text-[11px] font-semibold leading-none" aria-hidden>
        {brand.mark.text}
      </span>
    )
  }
  const fill = brandFill(brand.mark)
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 fill-current"
      aria-hidden
      // ui-check-ok: a brand mark is drawn in the brand's own colour (data from the brand registry, not a theme colour)
      style={fill === null ? undefined : { fill }}
    >
      <path d={brand.mark.path} />
    </svg>
  )
}
