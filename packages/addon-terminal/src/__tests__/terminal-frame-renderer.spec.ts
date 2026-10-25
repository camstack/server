import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { TerminalStyledRow } from '../terminal-cell-runs.js'
import {
  renderTerminalJpeg,
  renderTerminalSvg,
  TERMINAL_CAMERA_HEIGHT,
  TERMINAL_CAMERA_WIDTH,
} from '../terminal-frame-renderer.js'
import { createXtermScreen } from '../xterm-screen.js'

/** Rows with no attributes at all — the shape the renderer used to take. */
function plainRows(...lines: readonly string[]): readonly TerminalStyledRow[] {
  return lines.map((text) => [{ text, fg: null, bg: null, bold: false }])
}

/**
 * Whether this host's rasterizer can draw text at all: librsvg finds fonts
 * through fontconfig, and a font-less container (the CI runner's) draws
 * nothing, so a drawn-extent measurement there can only read 0.
 *
 * Threshold is not `> 0`: a black JPEG can still trip a single bright DCT
 * artifact above the ink floor, which used to mark the host as drawable and
 * then fail the padded-vs-tight check with both extents still 0.
 */
const HOST_DRAWS_TEXT = (await drawnExtent('MMMM')) > 20

/** Read one styled screen back the way the relay does. */
async function styledRows(data: string, cols = 40): Promise<readonly TerminalStyledRow[]> {
  const screen = createXtermScreen(cols, 4)
  screen.write(data)
  await screen.flush()
  const rows = screen.styledLines()
  screen.dispose()
  return rows
}

describe('terminal camera frame renderer', () => {
  it('renders interpreted terminal rows as a fixed-size JPEG', async () => {
    const screen = createXtermScreen(40, 4)
    screen.write('\x1b[31mCPU < 10% & stable\x1b[0m\r\nsecond line')
    await screen.flush()

    const jpeg = await renderTerminalJpeg(screen.styledLines())
    const metadata = await sharp(jpeg).metadata()

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(metadata).toMatchObject({
      format: 'jpeg',
      width: TERMINAL_CAMERA_WIDTH,
      height: TERMINAL_CAMERA_HEIGHT,
    })
    screen.dispose()
  })

  /**
   * A terminal screen is mostly box-drawing and block characters. Naming ONE
   * family and a generic left the Mac agent — which has neither DejaVu nor
   * fontconfig — falling through to a face without them, and its Glances
   * camera rendered as noise while the hub's, same session, was pixel-perfect.
   *
   * Asserted on the stack rather than on pixels because the failure only
   * reproduces on a host missing the font: a renderer test on a machine that
   * HAS DejaVu cannot see it. What is checkable everywhere is that we do not
   * bet the frame on one family.
   */
  it('offers a real monospace fallback on every host, not just a generic', async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../terminal-frame-renderer.ts'),
      'utf8',
    )
    const stack = /const TERMINAL_FONT_STACK = '([^']+)'/.exec(source)?.[1] ?? ''
    const families = stack.split(',').map((f) => f.trim())

    // Linux/containers, macOS, and a last-resort generic.
    expect(families).toContain('DejaVu Sans Mono')
    expect(families).toContain('Menlo')
    expect(families.at(-1)).toBe('monospace')
    // More than one REAL family — a generic alone is what produced the noise.
    expect(families.filter((f) => f !== 'monospace').length).toBeGreaterThan(1)
  })

  /**
   * Column alignment IS runs of spaces — Glances pads every field with them.
   * SVG `<text>` collapses those runs unless told not to, and the operator's
   * report was the visible half of it: over `attach` the session looked
   * perfect, in the STREAM the same screen was squeezed into the top-left of a
   * mostly-black frame.
   *
   * Asserted on the document the rasterizer is handed, which is the same on
   * every host: the padding must reach it verbatim, under
   * `xml:space="preserve"` (librsvg honours it: measured in the hub's own
   * rasterizer 2026-08-11, 92 px collapsed against 178 px preserved). A pixel
   * measurement needs a font, and the CI runner's container has none —
   * nothing draws at all there, so the padded and tight lines both measure 0
   * and the check judged the host instead of the renderer. The drawn-extent
   * measurement below still runs wherever text can be drawn.
   */
  it('preserves runs of spaces, so a padded line keeps its width', () => {
    const padded = 'AAA          BBB   CCC'
    const [text, ...others] = textElements(renderTerminalSvg(plainRows(padded)))

    expect(others).toHaveLength(0)
    expect(text).toContain('xml:space="preserve"')
    expect(text).toContain(`>${padded}</text>`)
  })

  it.runIf(HOST_DRAWS_TEXT)(
    'draws a padded line visibly wider than the tight one (needs a font on the host)',
    async ({ skip }) => {
      // Same glyphs, same count — the ONLY difference is the run of spaces.
      const padded = await drawnExtent('AAA          BBB   CCC')
      const tight = await drawnExtent('AAA BBB CCC')

      // Fontconfig on the runner can answer the module probe and then draw
      // nothing on the next raster — treat zero ink as "host cannot draw".
      if (padded === 0 || tight === 0) {
        skip('no ink from the rasterizer — font unavailable for this check')
        return
      }

      // Collapsed, the padded line would draw at the tight line's width. It
      // must instead run visibly wider — the padding is the layout.
      expect(padded).toBeGreaterThan(tight * 1.5)
    },
  )
})

/** Rightmost glyph pixel of one rendered line; 0 when nothing was drawn. */
async function drawnExtent(line: string): Promise<number> {
  const jpeg = await renderTerminalJpeg(plainRows(line))
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true })
  let maxX = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      // The background is #0b0d10; anything well above it is glyph.
      if ((data[y * info.width + x] ?? 0) > 60) maxX = Math.max(maxX, x)
    }
  }
  return maxX
}

/** Every `<text …>…</text>` element in a rendered frame, in document order. */
function textElements(svg: string): readonly string[] {
  return svg.match(/<text\b[^>]*>[^<]*<\/text>/g) ?? []
}

/** Every `<rect …/>` element except the full-frame background. */
function runRects(svg: string): readonly string[] {
  return (svg.match(/<rect\b[^>]*\/>/g) ?? []).filter((rect) => !rect.includes('100%'))
}

describe('terminal camera frame renderer colours', () => {
  /**
   * The operator's report was "glances works in the terminal camera but the
   * COLOURS are missing" — measured as 16-colour SGR arriving (`CSI 32m` ×104
   * in one frame) and being discarded at the cell read, because the only cell
   * reader was `translateToString`, which keeps characters and nothing else.
   */
  it('paints a coloured run with its resolved foreground', async () => {
    const svg = renderTerminalSvg(await styledRows('\x1b[32mOK\x1b[0m plain'))

    expect(svg).toContain('fill="#98c379"')
  })

  it('leaves default-coloured runs without a fill, inheriting the group', async () => {
    const svg = renderTerminalSvg(await styledRows('\x1b[32mOK\x1b[0m plain'))
    const plain = textElements(svg).find((element) => element.includes('plain'))

    expect(plain).toBeDefined()
    expect(plain).not.toContain('fill=')
    // The default foreground is declared once, on the wrapping group.
    expect(svg).toContain('fill="#d7dce2" font-family=')
  })

  it('emits a background rect only where the background is not the default', async () => {
    const svg = renderTerminalSvg(await styledRows('plain\x1b[42m LOW \x1b[0m'))
    const rects = runRects(svg)

    expect(rects).toHaveLength(1)
    expect(rects[0]).toContain('fill="#98c379"')
    // 5 columns of background, starting at column 5 of row 0.
    expect(rects[0]).toContain(`x="${String(Number((8 + 5 * (13 * (1233 / 2048))).toFixed(2)))}"`)
    expect(rects[0]).toContain(`width="${String(Number((5 * (13 * (1233 / 2048))).toFixed(2)))}"`)
    expect(rects[0]).toContain('height="15"')
  })

  /**
   * librsvg ignores `textLength` (measured: a 120-glyph run pinned to 600px
   * drew at its natural 937px), so per-run `x` anchoring is what actually keeps
   * the rect grid and the glyph grid together. The attribute is still emitted
   * because it is correct, and renderers that honour it get an exact grid.
   */
  it('pins every run to its column and declares its intended width', async () => {
    const svg = renderTerminalSvg(await styledRows('\x1b[32mOK\x1b[0m plain'))
    const cellWidth = 13 * (1233 / 2048)
    const second = textElements(svg).find((element) => element.includes('plain'))

    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"')
    expect(second).toContain(`x="${String(Number((8 + 2 * cellWidth).toFixed(2)))}"`)
    expect(second).toContain(`textLength="${String(Number((6 * cellWidth).toFixed(2)))}"`)
  })

  it('marks a bold run with a font weight rather than a brighter colour', async () => {
    const svg = renderTerminalSvg(await styledRows('\x1b[0;1;32mBOLD'))
    const bold = textElements(svg).find((element) => element.includes('BOLD'))

    expect(bold).toContain('font-weight="bold"')
    expect(bold).toContain('fill="#98c379"')
  })

  it('still escapes XML in the run text', async () => {
    const svg = renderTerminalSvg(await styledRows('\x1b[31mCPU < 10% & "up"'))

    expect(svg).toContain('CPU &lt; 10% &amp; &quot;up&quot;')
  })

  /**
   * Run merging IS the size bound. A 120×40 screen is 4800 cells, and a
   * per-cell element would put 4800 of them into every frame at 2fps. A screen
   * whose styles repeat must cost elements proportional to its RUNS.
   */
  it('costs runs, not cells, on a screen whose styles repeat', async () => {
    const screen = createXtermScreen(120, 40)
    const line = `\x1b[32m${'A'.repeat(60)}\x1b[42;30m${'B'.repeat(60)}\x1b[0m`
    // No trailing newline: a 40th one would scroll row 0 away.
    screen.write(Array.from({ length: 40 }, () => line).join('\r\n'))
    await screen.flush()
    const svg = renderTerminalSvg(screen.styledLines())
    screen.dispose()

    // Two runs per row, forty rows — nowhere near the 4800 cells they cover.
    expect(textElements(svg)).toHaveLength(80)
    expect(runRects(svg)).toHaveLength(40)
  })

  it('advances the row grid by one row height per line', async () => {
    const svg = renderTerminalSvg(await styledRows('\x1b[42mA\x1b[0m\r\n\x1b[42mB\x1b[0m'))
    const rects = runRects(svg)

    expect(rects).toHaveLength(2)
    expect(rects[0]).toContain('y="6.5"')
    expect(rects[1]).toContain('y="21.5"')
  })

  it('renders a coloured screen to a JPEG that actually carries the colour', async () => {
    const jpeg = await renderTerminalJpeg(await styledRows('\x1b[42m' + ' '.repeat(30)))
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
    // Sample the middle of the first row's background bar.
    const offset = (10 * info.width + 60) * info.channels

    expect(data[offset + 1]).toBeGreaterThan(150)
    expect(data[offset + 0]).toBeLessThan(data[offset + 1] ?? 0)
  })
})
