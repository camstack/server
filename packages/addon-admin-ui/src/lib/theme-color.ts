/**
 * Keeps `<meta name="theme-color">` equal to the header's surface colour.
 *
 * The installed iOS app uses `apple-mobile-web-app-status-bar-style=default`,
 * so iOS paints the status bar itself, in the `theme-color` colour. The mobile
 * header is `bg-surface`, so the bar and the header must be the same colour in
 * the ACTIVE theme. The colour is read from the `--color-surface` token, never
 * spelled here. The theme is chosen in-app (`camstack-theme-mode`), so the OS
 * `prefers-color-scheme` media variants of the meta tag cannot be used.
 */

const SURFACE_TOKEN = '--color-surface'

function themeColorMeta(doc: Document): HTMLMetaElement {
  const existing = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (existing) return existing
  const created = doc.createElement('meta')
  created.name = 'theme-color'
  doc.head.appendChild(created)
  return created
}

/** Copies the current `--color-surface` onto the meta tag. No-op while the token is unresolved. */
export function syncThemeColor(doc: Document = document): void {
  const surface = doc.defaultView
    ?.getComputedStyle(doc.documentElement)
    .getPropertyValue(SURFACE_TOKEN)
    .trim()
  if (!surface) return
  const meta = themeColorMeta(doc)
  if (meta.content !== surface) meta.content = surface
}

/**
 * Syncs now and whenever the ThemeProvider (or the pre-paint script) flips the
 * `.dark` / `.light` class on `<html>`. Observing the class avoids depending on
 * effect order against the provider. Returns the unsubscribe.
 */
export function watchThemeColor(doc: Document = document): () => void {
  syncThemeColor(doc)
  const win = doc.defaultView
  if (!win) return () => undefined
  const observer = new win.MutationObserver(() => syncThemeColor(doc))
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
