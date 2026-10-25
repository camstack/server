/**
 * `ui:shots` — the pure halves: argument parsing, the in-page measurement
 * (run here against a fake DOM with hand-set geometry, since jsdom has no
 * layout) and the markdown report with its before/after regression flags.
 * The browser run itself is `ui-shots.integration.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseShotsArgs } from '../ui/shots/lib/args.js'
import {
  measureInPage,
  type RawMeasure,
  stickyProbe,
  summarizeMeasure,
} from '../ui/shots/lib/measure.js'
import {
  compareReports,
  renderReport,
  type ShotRecord,
  type ShotsReport,
  shotKey,
} from '../ui/shots/lib/report.js'

const ROOT = '/repo'

describe('parseShotsArgs', () => {
  it('defaults to light+dark at 1440×900 and 390×844 into scratchpad/ui-shots/<label>', () => {
    const a = parseShotsArgs(['--route', '/system/identity?tab=access'], ROOT)
    if ('error' in a) throw new Error(a.error)
    expect(a.routes).toEqual(['/system/identity?tab=access'])
    expect(a.themes).toEqual(['light', 'dark'])
    expect(a.viewports).toEqual([
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'phone', width: 390, height: 844 },
    ])
    expect(a.label).toBe('current')
    expect(a.out).toBe('/repo/scratchpad/ui-shots/current')
    expect(a.fixtures).toBe('all')
    expect(a.compare).toBeNull()
  })

  it('takes label, out, fixtures, compare, theme and extra viewports', () => {
    const a = parseShotsArgs(
      [
        '--route=/a',
        '--route',
        '/b',
        '--label',
        'after',
        '--fixtures',
        'access,backup',
        '--compare',
        'scratchpad/ui-shots/before',
        '--theme',
        'dark',
        '--viewport',
        '320x640',
      ],
      ROOT,
    )
    if ('error' in a) throw new Error(a.error)
    expect(a.routes).toEqual(['/a', '/b'])
    expect(a.out).toBe('/repo/scratchpad/ui-shots/after')
    expect(a.fixtures).toEqual(['access', 'backup'])
    expect(a.compare).toBe('/repo/scratchpad/ui-shots/before')
    expect(a.themes).toEqual(['dark'])
    expect(a.viewports).toEqual([{ name: '320x640', width: 320, height: 640 }])
  })

  it('refuses a missing route, a route without a leading slash, a bad viewport and a bad label', () => {
    expect(parseShotsArgs([], ROOT)).toHaveProperty('error')
    expect(parseShotsArgs(['--route', 'system'], ROOT)).toHaveProperty('error')
    expect(parseShotsArgs(['--route', '/a', '--viewport', 'wide'], ROOT)).toHaveProperty('error')
    expect(parseShotsArgs(['--route', '/a', '--label', '../x'], ROOT)).toHaveProperty('error')
    expect(parseShotsArgs(['--route', '/a', '--theme', 'sepia'], ROOT)).toHaveProperty('error')
    expect(parseShotsArgs(['--route', '/a', '--bogus'], ROOT)).toHaveProperty('error')
  })
})

// ── Fake DOM ───────────────────────────────────────────────────────────────

interface FakeBox {
  left: number
  right: number
  top: number
  bottom: number
}
interface FakeEl {
  tagName: string
  id: string
  className: string
  parentElement: FakeEl | null
  box: FakeBox
  style: {
    position: string
    overflowX: string
    visibility: string
    display: string
    opacity: string
  }
  attrs: Map<string, string>
  children: FakeEl[]
  querySelector(sel: string): FakeEl | null
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  getBoundingClientRect(): FakeBox & { width: number; height: number }
  getAttribute(k: string): string | null
  setAttribute(k: string, v: string): void
}

function el(
  tag: string,
  parent: FakeEl | null,
  box: Partial<FakeBox>,
  style: Partial<FakeEl['style']> = {},
  extra: Partial<Pick<FakeEl, 'id' | 'className'>> = {},
): FakeEl {
  const b: FakeBox = { left: 0, right: 100, top: 0, bottom: 20, ...box }
  const e: FakeEl = {
    tagName: tag.toUpperCase(),
    id: extra.id ?? '',
    className: extra.className ?? '',
    parentElement: parent,
    box: b,
    style: {
      position: 'static',
      overflowX: 'visible',
      visibility: 'visible',
      display: 'block',
      opacity: '1',
      ...style,
    },
    attrs: new Map(),
    children: [],
    // Only the one query the probe makes: a marked direct child.
    querySelector: (sel) =>
      sel === ':scope > [data-shots-sticky]'
        ? (e.children.find((c) => c.attrs.has('data-shots-sticky')) ?? null)
        : null,
    scrollWidth: 0,
    clientWidth: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getBoundingClientRect() {
      return { ...e.box, width: e.box.right - e.box.left, height: e.box.bottom - e.box.top }
    },
    getAttribute: (k) => e.attrs.get(k) ?? null,
    setAttribute: (k, v) => {
      e.attrs.set(k, v)
    },
  }
  parent?.children.push(e)
  return e
}

function installDom(width: number, height: number, all: FakeEl[], main: FakeEl | null) {
  const docEl = {
    scrollWidth: width,
    clientWidth: width,
    scrollHeight: height,
    clientHeight: height,
    scrollTop: 0,
  }
  const body = all[0]
  vi.stubGlobal('window', {
    innerWidth: width,
    innerHeight: height,
    getComputedStyle: (e: FakeEl) => e.style,
  })
  vi.stubGlobal('document', {
    documentElement: docEl,
    scrollingElement: docEl,
    body,
    querySelector: (sel: string) => (sel === 'main' ? main : null),
    querySelectorAll: (sel: string) =>
      sel === 'body *'
        ? all.slice(1)
        : sel === '[data-shots-sticky]'
          ? all.filter((e) => e.attrs.has('data-shots-sticky'))
          : [],
  })
  return docEl
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('measureInPage', () => {
  it('reports document and main horizontal overflow', () => {
    const body = el('body', null, { right: 390 })
    const main = el('main', body, { right: 390 })
    main.scrollWidth = 450
    main.clientWidth = 390
    const docEl = installDom(390, 844, [body, main], main)
    docEl.scrollWidth = 410
    const m = summarizeMeasure(measureInPage())
    expect(m.overflowDoc).toBe(20)
    expect(m.overflowMain).toBe(60)
  })

  it('lists the OUTERMOST element past the viewport edge, not its children', () => {
    const body = el('body', null, { right: 390 })
    const main = el('main', body, { right: 390 })
    const card = el('div', main, { left: 16, right: 520 }, {}, { className: 'card wide extra' })
    const child = el('span', card, { left: 20, right: 510 })
    installDom(390, 844, [body, main, card, child], main)
    const raw = measureInPage()
    expect(raw.wide).toHaveLength(1)
    expect(raw.wide[0]?.selector).toBe('div.card.wide')
    expect(raw.wide[0]?.right).toBe(520)
  })

  it('ignores content clipped by a scroll container and off-canvas drawers', () => {
    const body = el('body', null, { right: 390 })
    const scroller = el('div', body, { left: 0, right: 390 }, { overflowX: 'auto' })
    const table = el('table', scroller, { left: 0, right: 900 })
    const drawer = el('aside', body, { left: -300, right: 0 }, { position: 'fixed' })
    const hidden = el('div', body, { left: 0, right: 900 }, { visibility: 'hidden' })
    installDom(390, 844, [body, scroller, table, drawer, hidden], null)
    expect(measureInPage().wide).toEqual([])
  })

  it('reports main as null when the page has no main', () => {
    const body = el('body', null, { right: 1440 })
    installDom(1440, 900, [body], null)
    expect(summarizeMeasure(measureInPage()).overflowMain).toBeNull()
  })
})

describe('stickyProbe', () => {
  it('marks sticky/fixed elements visible before the scroll and calls them pinned when still visible after', () => {
    const body = el('body', null, { right: 390, bottom: 3000 })
    const header = el(
      'header',
      body,
      { top: 0, bottom: 56 },
      { position: 'sticky' },
      { className: 'top' },
    )
    const save = el(
      'div',
      body,
      { top: 780, bottom: 844 },
      { position: 'sticky' },
      { className: 'save-bar' },
    )
    const broken = el(
      'div',
      body,
      { top: 100, bottom: 140 },
      { position: 'sticky' },
      { className: 'broken' },
    )
    // A sticky header row: its cells count once.
    const tr = el('tr', body, { top: 200, bottom: 240 })
    const th1 = el(
      'th',
      tr,
      { top: 200, bottom: 240 },
      { position: 'sticky' },
      { className: 'cell' },
    )
    const th2 = el(
      'th',
      tr,
      { left: 100, right: 200, top: 200, bottom: 240 },
      { position: 'sticky' },
      { className: 'cell' },
    )
    // A transparent overlay is not a visible bar.
    const scrim = el('div', body, { right: 390, bottom: 844 }, { position: 'fixed', opacity: '0' })
    // An off-canvas drawer is fixed but not on screen: not tested.
    const drawer = el(
      'aside',
      body,
      { left: -300, right: 0, top: 0, bottom: 844 },
      { position: 'fixed' },
    )
    const docEl = installDom(
      390,
      844,
      [body, header, save, broken, tr, th1, th2, scrim, drawer],
      null,
    )
    docEl.scrollHeight = 3000
    const marked = stickyProbe('mark')
    expect(marked.map((s) => s.selector)).toEqual([
      'header.top',
      'div.save-bar',
      'div.broken',
      'th.cell',
    ])
    // The browser scrolls; the broken one scrolls away with its box.
    broken.box = { ...broken.box, top: -744, bottom: -704 }
    const after = stickyProbe('read')
    expect(after.filter((s) => s.visible).map((s) => s.selector)).toEqual([
      'header.top',
      'div.save-bar',
      'th.cell',
    ])
  })
})

describe('summarizeMeasure', () => {
  it('counts pinned stickies and treats no scroll as not measured', () => {
    const raw: RawMeasure = {
      viewport: { width: 390, height: 844 },
      doc: { scrollWidth: 390, clientWidth: 390 },
      main: { scrollWidth: 390, clientWidth: 390 },
      wide: [],
      sticky: {
        scrolled: true,
        before: [
          { selector: 'header', visible: true },
          { selector: 'div.save', visible: true },
        ],
        after: [
          { selector: 'header', visible: true },
          { selector: 'div.save', visible: false },
        ],
      },
    }
    const m = summarizeMeasure(raw)
    expect(m.sticky).toEqual({
      measured: true,
      total: 2,
      pinned: 1,
      unpinned: ['div.save'],
      checked: ['header', 'div.save'],
    })
    expect(
      summarizeMeasure({ ...raw, sticky: { scrolled: false, before: [], after: [] } }).sticky
        .measured,
    ).toBe(false)
  })
})

// ── Report ─────────────────────────────────────────────────────────────────

const shot = (over: Partial<ShotRecord> = {}): ShotRecord => ({
  route: '/system/identity?tab=access',
  theme: 'light',
  viewport: { name: 'desktop', width: 1440, height: 900 },
  image: 'system-identity-tab-access--desktop-light.png',
  measurement: {
    overflowDoc: 0,
    overflowMain: 0,
    wide: [],
    sticky: { measured: true, total: 1, pinned: 1, unpinned: [], checked: ['header'] },
  },
  missingFixtures: [],
  pageErrors: [],
  ...over,
})

const report = (shots: ShotRecord[], label = 'after'): ShotsReport => ({
  label,
  createdAt: '2026-10-11T10:00:00.000Z',
  commit: 'abc1234',
  fixtures: ['access'],
  shots,
})

describe('renderReport', () => {
  it('writes one measurement row per shot with its image path', () => {
    const md = renderReport(report([shot(), shot({ theme: 'dark', image: 'x-dark.png' })]))
    expect(md).toContain('# UI shots — after')
    expect(md).toContain(
      '| /system/identity?tab=access | desktop 1440×900 | light | 0 | 0 | 0 | 1/1 | ok | ![](system-identity-tab-access--desktop-light.png) |',
    )
    expect(md).toContain('| dark |')
  })

  it('surfaces missing fixtures and page errors', () => {
    const md = renderReport(
      report([shot({ missingFixtures: ['auth.listSessions'], pageErrors: ['boom'] })]),
    )
    expect(md).toContain('missing fixture: auth.listSessions')
    expect(md).toContain('page error: boom')
  })
})

describe('compareReports', () => {
  it('flags new overflow, new wide elements, lost pinning and new errors as regressions', () => {
    const before = report([shot()], 'before')
    const after = report([
      shot({
        measurement: {
          overflowDoc: 12,
          overflowMain: 0,
          wide: [{ selector: 'div.card', left: 0, right: 1452, width: 1452 }],
          sticky: {
            measured: true,
            total: 1,
            pinned: 0,
            unpinned: ['div.save'],
            checked: ['div.save'],
          },
        },
        pageErrors: ['x is undefined'],
      }),
    ])
    const regs = compareReports(before, after)
    expect(regs.map((r) => r.what)).toEqual([
      'document overflow 0 → 12 px',
      'elements past the viewport 0 → 1 (div.card)',
      'pinned sticky 1 → 0 (div.save)',
      'new page error: x is undefined',
    ])
  })

  it('reports nothing when the after run is equal or better, and notes shots only on one side', () => {
    const before = report(
      [shot({ measurement: { ...shot().measurement, overflowDoc: 30 } })],
      'before',
    )
    const after = report([shot(), shot({ theme: 'dark' })])
    const regs = compareReports(before, after)
    expect(regs).toEqual([
      { key: shotKey(shot({ theme: 'dark' })), what: 'new shot (no before)', regression: false },
    ])
  })

  it('renders a side-by-side section with both image paths', () => {
    const md = renderReport(report([shot()]), {
      before: report([shot()], 'before'),
      beforeDir: '../before',
    })
    expect(md).toContain('## Before / after')
    expect(md).toContain('![before](../before/system-identity-tab-access--desktop-light.png)')
    expect(md).toContain('No regressions.')
  })
})
