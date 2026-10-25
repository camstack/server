/**
 * What `ui:shots` measures on each page, in the browser.
 *
 * `measureInPage`, `stickyProbe` and `scrollForSticky` are handed to
 * Playwright's `page.evaluate`, which serialises the function source: they
 * must not reference anything outside their own body (no imports, no
 * module-level helpers). `summarizeMeasure` runs in Node.
 */

export interface WideElement {
  readonly selector: string
  readonly left: number
  readonly right: number
  readonly width: number
}

export interface StickyState {
  readonly selector: string
  /** Fully inside the viewport vertically. */
  readonly visible: boolean
}

export interface RawMeasure {
  readonly viewport: { readonly width: number; readonly height: number }
  readonly doc: { readonly scrollWidth: number; readonly clientWidth: number }
  readonly main: { readonly scrollWidth: number; readonly clientWidth: number } | null
  /** Outermost visible elements that cross the left or right viewport edge, unclipped. */
  readonly wide: readonly WideElement[]
  readonly sticky: {
    /** False when nothing could scroll — pinning was not tested. */
    readonly scrolled: boolean
    readonly before: readonly StickyState[]
    readonly after: readonly StickyState[]
  }
}

export interface Measurement {
  /** `scrollWidth - clientWidth` of the document: > 0 = horizontal page scroll. */
  readonly overflowDoc: number
  /** Same for `<main>`; null when the page has none. */
  readonly overflowMain: number | null
  readonly wide: readonly WideElement[]
  readonly sticky: {
    readonly measured: boolean
    readonly total: number
    readonly pinned: number
    readonly unpinned: readonly string[]
    /** Every sticky / fixed element that was tested. */
    readonly checked: readonly string[]
  }
}

/** Overflow, and the elements responsible for it. Sticky is filled in by the runner. */
export function measureInPage(): RawMeasure {
  const MAX_WIDE = 10
  const vw = window.innerWidth
  const describe = (e: Element): string => {
    const tag = e.tagName.toLowerCase()
    if (e.id) return `${tag}#${e.id}`
    const cls =
      typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean) : []
    return cls.length > 0 ? `${tag}.${cls.slice(0, 2).join('.')}` : tag
  }
  const crosses = (r: { left: number; right: number }): boolean => r.left < -1 || r.right > vw + 1
  const flagged = new Set<Element>()
  const wide: WideElement[] = []
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    if (wide.length >= MAX_WIDE) break
    const style = window.getComputedStyle(e)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
    const r = e.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    // Wholly outside the viewport = an off-canvas drawer, not overflow (the
    // document overflow figure still catches one that widens the page).
    if (r.right <= 0 || r.left >= vw) continue
    if (!crosses(r)) continue
    let skip = false
    for (let a = e.parentElement; a !== null; a = a.parentElement) {
      if (flagged.has(a)) {
        skip = true
        break
      }
      const ox = window.getComputedStyle(a).overflowX
      if (
        (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') &&
        !crosses(a.getBoundingClientRect())
      ) {
        skip = true
        break
      }
    }
    if (skip) continue
    flagged.add(e)
    wide.push({
      selector: describe(e),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
    })
  }
  const d = document.documentElement
  const main = document.querySelector('main')
  return {
    viewport: { width: vw, height: window.innerHeight },
    doc: { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth },
    main: main === null ? null : { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth },
    wide,
    sticky: { scrolled: false, before: [], after: [] },
  }
}

/**
 * `mark`: tag every sticky / fixed element fully visible now; `read`: report
 * the tagged ones again. Between the two the runner scrolls — a header or
 * save bar that is still fully visible after the scroll stayed pinned.
 */
export function stickyProbe(phase: 'mark' | 'read'): StickyState[] {
  const ATTR = 'data-shots-sticky'
  const MAX = 20
  const vh = window.innerHeight
  const vw = window.innerWidth
  const describe = (e: Element): string => {
    const tag = e.tagName.toLowerCase()
    if (e.id) return `${tag}#${e.id}`
    const cls =
      typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean) : []
    return cls.length > 0 ? `${tag}.${cls.slice(0, 2).join('.')}` : tag
  }
  const visible = (e: Element): boolean => {
    const r = e.getBoundingClientRect()
    return (
      r.height > 0 && r.width > 0 && r.right > 0 && r.left < vw && r.top >= -1 && r.bottom <= vh + 1
    )
  }
  if (phase === 'read') {
    return Array.from(document.querySelectorAll(`[${ATTR}]`))
      .toSorted((a, b) => Number(a.getAttribute(ATTR)) - Number(b.getAttribute(ATTR)))
      .map((e) => ({ selector: describe(e), visible: visible(e) }))
  }
  const out: StickyState[] = []
  for (const e of Array.from(document.querySelectorAll('body *'))) {
    if (out.length >= MAX) break
    const s = window.getComputedStyle(e)
    if (s.position !== 'sticky' && s.position !== 'fixed') continue
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || !visible(e))
      continue
    // The cells of a sticky header row count once.
    const cell = e.tagName === 'TH' || e.tagName === 'TD'
    if (cell && e.parentElement?.querySelector(`:scope > [${ATTR}]`)) continue
    e.setAttribute(ATTR, String(out.length))
    out.push({ selector: describe(e), visible: true })
  }
  return out
}

/** Scroll the page's scroller (`<main>` when it scrolls, else the document) by up to a screen. */
export function scrollForSticky(): boolean {
  const main = document.querySelector('main')
  const scroller =
    main !== null && main.scrollHeight > main.clientHeight + 1
      ? main
      : (document.scrollingElement ?? document.documentElement)
  const room = scroller.scrollHeight - scroller.clientHeight
  if (room <= 1) return false
  scroller.scrollTop = Math.min(room, window.innerHeight)
  return true
}

export function summarizeMeasure(raw: RawMeasure): Measurement {
  const after = new Map(raw.sticky.after.map((s, i) => [i, s]))
  const unpinned = raw.sticky.before
    .map((s, i) => ({ s, a: after.get(i) }))
    .filter(({ a }) => a !== undefined && !a.visible)
    .map(({ s }) => s.selector)
  const total = raw.sticky.before.length
  return {
    overflowDoc: Math.max(0, raw.doc.scrollWidth - raw.doc.clientWidth),
    overflowMain:
      raw.main === null ? null : Math.max(0, raw.main.scrollWidth - raw.main.clientWidth),
    wide: raw.wide,
    sticky: {
      measured: raw.sticky.scrolled,
      total,
      pinned: raw.sticky.scrolled ? total - unpinned.length : 0,
      unpinned,
      checked: raw.sticky.before.map((s) => s.selector),
    },
  }
}
