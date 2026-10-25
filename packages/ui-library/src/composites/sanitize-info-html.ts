/**
 * Sanitize a small HTML subset for `ConfigInfoField.format='html'`.
 *
 * Only `<a>`, `<ul>`, `<ol>`, `<li>`, `<strong>`, `<em>`, `<code>`,
 * `<br>`, `<p>`, and `<span>` are kept. On anchors, only `href` and a
 * normalised `target`/`rel` are emitted; everything else is dropped
 * (including event handlers and inline styles).
 *
 * Allowed `href` schemes: `http(s):`, `mailto:`, and **root-relative**
 * paths (`/addon/…`). Root-relative links stay same-tab (session cookie);
 * absolute http(s) open in a new tab. Protocol-relative (`//…`) is refused.
 *
 * The input comes from addon-authored copy bundled at build time —
 * sanitisation is defence in depth rather than primary trust boundary.
 */
export function sanitizeInfoHtml(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return ''
  const ALLOWED_TAGS = new Set([
    'A',
    'UL',
    'OL',
    'LI',
    'STRONG',
    'EM',
    'CODE',
    'BR',
    'P',
    'SPAN',
    'B',
  ])
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  const walk = (node: Element): void => {
    const children = Array.from(node.children)
    for (const child of children) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        const text = doc.createTextNode(child.textContent ?? '')
        child.replaceWith(text)
        continue
      }
      const allowed = child.tagName === 'A' ? new Set(['href']) : new Set<string>()
      for (const attr of Array.from(child.attributes)) {
        if (!allowed.has(attr.name)) child.removeAttribute(attr.name)
      }
      if (child.tagName === 'A') {
        const href = child.getAttribute('href') ?? ''
        const isHttp = /^https?:\/\//i.test(href)
        const isMailto = href.startsWith('mailto:')
        const isRootRelative = href.startsWith('/') && !href.startsWith('//')
        if (!isHttp && !isMailto && !isRootRelative) {
          child.removeAttribute('href')
        } else if (isHttp) {
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noopener noreferrer')
        }
        // Root-relative / mailto: same tab — keep the admin session cookie.
      }
      walk(child)
    }
  }
  walk(root)
  return root.innerHTML
}
