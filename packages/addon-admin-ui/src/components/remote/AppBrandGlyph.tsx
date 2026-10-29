/**
 * Draws one app brand from the registry in the surrounding text colour: the
 * brand's glyph, or its lettermark when the glyph set has none.
 */
import type { ReactNode } from 'react'
import type { AppBrand } from './app-brand-icons'

export function AppBrandGlyph({ brand }: { readonly brand: AppBrand }): ReactNode {
  if (brand.mark.kind === 'lettermark') {
    return (
      <span className="text-[11px] font-semibold leading-none" aria-hidden>
        {brand.mark.text}
      </span>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
      <path d={brand.mark.path} />
    </svg>
  )
}
