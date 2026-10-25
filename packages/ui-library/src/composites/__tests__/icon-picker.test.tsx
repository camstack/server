// @vitest-environment jsdom
/**
 * <IconPicker> — the one icon control, over the one icon catalog (D854).
 *
 * What is pinned here:
 *
 *  - **One view.** The list opens as lucide-category sections over the WHOLE
 *    catalog; there is no curated section and no per-caller subset.
 *  - **It is virtualised.** ~1,700 tiles are never mounted at once, and
 *    scrolling brings the later rows in.
 *  - **Search reaches an icon by an Italian word**, and answers one ranked list.
 *  - **The clear tile survives every query.** It is the only way back from a
 *    glyph picked by accident, so a search that hid it would strand the
 *    operator.
 *  - **Aliases are never offered**, but a stored alias is shown as selected.
 */
import { ICON_KEYS, iconsInCategory } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { Ban, MapPin } from 'lucide-react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadIconGlyphs } from '../icon-glyphs'
import { IconPicker, type IconPickerLabels } from '../icon-picker'

const LABELS: IconPickerLabels = {
  trigger: 'Change the icon',
  panel: 'Icon',
  searchPlaceholder: 'Search icons',
  clear: 'No icon',
  noMatches: 'Nothing matches',
}

beforeAll(async () => {
  await loadIconGlyphs()
}, 60_000)

function open(props: Partial<Parameters<typeof IconPicker>[0]> = {}) {
  const onPick = vi.fn()
  render(
    <IconPicker value={null} onPick={onPick} fallbackGlyph={MapPin} labels={LABELS} {...props} />,
  )
  fireEvent.click(screen.getByLabelText('Change the icon'))
  return { onPick }
}

const type = (query: string): void => {
  fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: query } })
}

const KEY_SET: ReadonlySet<string> = new Set(ICON_KEYS)

/** The keys currently MOUNTED as tiles, in DOM order. */
const tileKeys = (): readonly string[] =>
  screen
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'))
    .filter((l): l is string => l !== null && KEY_SET.has(l))

describe('<IconPicker>', () => {
  it('opens on category sections over the catalog, mounting only a window of it', () => {
    open()
    // The first section is the leading category, filed by its primary category.
    expect(screen.getByText('Devices')).toBeTruthy()
    const first = iconsInCategory('devices')[0]?.key
    expect(tileKeys()).toContain(first)
    // Virtualised: nowhere near the ~1,700 tiles of the catalog.
    expect(tileKeys().length).toBeGreaterThan(20)
    expect(tileKeys().length).toBeLessThan(200)
    expect(tileKeys().length).toBeLessThan(ICON_KEYS.length / 5)
  })

  it('scrolling mounts the later rows and unmounts the earlier ones', () => {
    open()
    const before = tileKeys()
    const scroller = screen.getByRole('dialog').querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    if (scroller === null) return
    fireEvent.scroll(scroller, { target: { scrollTop: 20000 } })
    const after = tileKeys()
    expect(after.length).toBeGreaterThan(0)
    expect(after.some((k) => before.includes(k))).toBe(false)
    expect(after.length).toBeLessThan(200)
  })

  it('derives a readable section title from the category id, unless the caller supplies one', () => {
    open({ categoryLabel: (c) => (c === 'devices' ? 'Dispositivi' : c) })
    expect(screen.getByText('Dispositivi')).toBeTruthy()
    expect(screen.queryByText('Devices')).toBeNull()
  })

  it('never offers a legacy or still-accepted spelling', () => {
    open()
    type('home')
    expect(tileKeys()).not.toContain('home')
    expect(tileKeys()).toContain('house')
    type('gauge2')
    expect(tileKeys()).not.toContain('gauge2')
  })

  it('finds an icon by an ITALIAN word, as one ranked list without section headers', () => {
    open()
    type('tapparella')
    expect(tileKeys()[0]).toBe('blinds')
    expect(screen.queryByText('Devices')).toBeNull()
  })

  it('reaches icons nobody curated through lucide English tags', () => {
    open()
    type('telescope')
    expect(tileKeys()).toContain('telescope')
  })

  it('keeps the clear tile through every query, including one that matches nothing', () => {
    // The only way back from a glyph picked by accident.
    open({ value: 'camera' })
    type('tapparella')
    expect(screen.getByText('No icon')).toBeTruthy()
    type('zzzzqqqq')
    expect(screen.getByText('No icon')).toBeTruthy()
    expect(screen.getByText('Nothing matches')).toBeTruthy()
    expect(tileKeys()).toEqual([])
  })

  it('picking clears the query, so the next open is the sections again', () => {
    const { onPick } = open()
    type('tapparella')
    fireEvent.click(screen.getByLabelText('blinds'))
    expect(onPick).toHaveBeenCalledWith('blinds')
    fireEvent.click(screen.getByLabelText('Change the icon'))
    expect(screen.getByText('Devices')).toBeTruthy()
  })

  it('the clear tile passes null, not an empty string', () => {
    const { onPick } = open({ value: 'camera' })
    fireEvent.click(screen.getByText('No icon'))
    expect(onPick).toHaveBeenCalledWith(null)
  })

  it('marks the stored value as pressed, even when it is stored under an alias', () => {
    open({ value: 'home' })
    type('house')
    expect(screen.getByLabelText('house').getAttribute('aria-pressed')).toBe('true')
  })

  it('the clear tile can wear its OWN glyph, because clearing is not always inherit', () => {
    // The room picker clears to nothing (`Ban`); the device picker clears to
    // the inherited glyph. Same control, two honest answers — so this asserts
    // the GLYPH, not the word next to it, which is the same either way.
    const glyphOfClearTile = (): string =>
      screen.getByText('No icon').querySelector('svg')?.getAttribute('class') ?? ''
    const first = render(
      <IconPicker
        value={null}
        onPick={vi.fn()}
        fallbackGlyph={MapPin}
        clearGlyph={Ban}
        labels={LABELS}
      />,
    )
    fireEvent.click(screen.getByLabelText('Change the icon'))
    expect(glyphOfClearTile()).toContain('ban')
    first.unmount()
    render(<IconPicker value={null} onPick={vi.fn()} fallbackGlyph={MapPin} labels={LABELS} />)
    fireEvent.click(screen.getByLabelText('Change the icon'))
    expect(glyphOfClearTile()).toContain('map-pin')
  })

  it('a tile is named by the caller`s label when it has one, by the key otherwise', () => {
    open({ labelFor: (key) => (key === 'utensils' ? 'Kitchen' : undefined) })
    type('utensils')
    expect(screen.getByLabelText('Kitchen')).toBeTruthy()
    type('camera')
    expect(screen.getByLabelText('camera')).toBeTruthy()
  })
})
