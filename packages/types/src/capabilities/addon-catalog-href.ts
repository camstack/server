/**
 * The Addons catalog filtered to the packages that declare `capability` — the
 * ONE spelling of that link (D860). It lives in `@camstack/types` so an addon's
 * own page (which may not import the admin UI) and the admin pages build it the
 * same way. `scripts/check-addon-install-links.ts` pins this file as the only
 * place the URL is written.
 */
export function addonCatalogHref(capability: string): string {
  return `/system/addons?${new URLSearchParams({ capability }).toString()}`
}
