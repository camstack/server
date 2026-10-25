import sharp from 'sharp'
import {
  TERMINAL_DEFAULT_BG,
  TERMINAL_DEFAULT_FG,
  type TerminalCellRun,
  type TerminalStyledRow,
} from './terminal-cell-runs.js'

export const TERMINAL_CAMERA_WIDTH = 960
export const TERMINAL_CAMERA_HEIGHT = 640
export const TERMINAL_CAMERA_COLS = 120
export const TERMINAL_CAMERA_ROWS = 40
export const TERMINAL_CAMERA_FPS = 2

/**
 * Monospace families to try, in order — NOT one family and a generic.
 *
 * A terminal screen is mostly box-drawing and block characters, and a font
 * without them renders the frame as noise rather than as missing detail.
 * `DejaVu Sans Mono` covers them and ships in the hub image; macOS has neither
 * DejaVu nor fontconfig, so the Mac agent fell through to a generic whose
 * coverage is not, and its Glances camera came out unreadable while the hub's
 * was pixel-perfect (measured 2026-08-11, same Glances, two nodes).
 *
 * `Menlo` is the fix rather than a guess: it is macOS's default terminal face,
 * present on every install, and derived from DejaVu Sans Mono — the same glyph
 * coverage by ancestry. Monaco and Courier New follow as older fallbacks; the
 * generic stays last so a host with none of them still draws something.
 */
const TERMINAL_FONT_STACK = 'DejaVu Sans Mono,Menlo,Monaco,Courier New,monospace'

const TERMINAL_FONT_SIZE = 13
const TERMINAL_TEXT_MARGIN_X = 8
const TERMINAL_ROW_HEIGHT = 15
const TERMINAL_BASELINE_Y = 18
/**
 * Distance from a row's baseline up to the top of its cell box. Chosen so
 * consecutive rows tile exactly: row N's box runs from `baseline - this` for
 * `TERMINAL_ROW_HEIGHT`, and row N+1's box starts where it ends. A background
 * bar that stopped short would draw as stripes across a `CSI 42m` panel.
 */
const TERMINAL_CELL_ASCENT = 11.5
/**
 * The monospace advance of the fonts we actually ship to, as a fraction of the
 * em: 1233/2048 for DejaVu Sans Mono (hub) and for Menlo, which derives from it
 * (Mac agent). Not a free parameter — measured in the hub's own rasterizer
 * 2026-08-12: a single 120-glyph `<text>` and 12 runs of 10 laid out at this
 * width produce the identical drawn extent (x 8→946), while 7.867 (a naive
 * width/cols) drifts 4px by the right margin.
 */
const TERMINAL_ADVANCE_RATIO = 1233 / 2048
const TERMINAL_CELL_WIDTH = TERMINAL_FONT_SIZE * TERMINAL_ADVANCE_RATIO

/** Two decimals is under a tenth of a pixel and keeps the SVG small. */
function coordinate(value: number): string {
  return String(Number(value.toFixed(2)))
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Render already-interpreted terminal rows into a compact MJPEG frame.
 *
 * `xml:space="preserve"` is load-bearing, not tidiness. SVG `<text>` collapses
 * runs of whitespace by default, and a terminal's entire column alignment IS
 * runs of whitespace — Glances pads every field with spaces. Without it the
 * frame drew each line at roughly half its true width, crammed into the
 * top-left of a mostly-black image, while the SAME session over `attach`
 * looked perfect — which is exactly how the operator reported it. Measured in
 * the hub's own rasterizer 2026-08-11: `AAA<10 spaces>BBB<3>CCC` drew 92 px
 * collapsed against 178 px preserved.
 *
 * Every run is anchored at its OWN column (`x = margin + startCol * cellW`),
 * never appended to the one before it, so the background rects and the glyphs
 * are placed off the same grid and cannot drift apart. `textLength` is emitted
 * with it because it is the correct declaration and renderers that honour it
 * get an exact grid — but it is not what makes this work: librsvg, which sharp
 * uses, ignores it outright (measured 2026-08-12, a 120-glyph run pinned to
 * 600 px still drew its natural 937 px). The anchoring is the guarantee.
 */
export function renderTerminalSvg(rows: readonly TerminalStyledRow[]): string {
  const backgrounds: string[] = []
  const texts: string[] = []
  rows.slice(0, TERMINAL_CAMERA_ROWS).forEach((row, index) => {
    const baseline = TERMINAL_BASELINE_Y + index * TERMINAL_ROW_HEIGHT
    const top = baseline - TERMINAL_CELL_ASCENT
    let column = 0
    for (const run of row) {
      if (column >= TERMINAL_CAMERA_COLS) break
      const clipped = clipRun(run, TERMINAL_CAMERA_COLS - column)
      const columns = [...clipped].length
      if (columns === 0) continue
      const x = TERMINAL_TEXT_MARGIN_X + column * TERMINAL_CELL_WIDTH
      const width = columns * TERMINAL_CELL_WIDTH
      if (run.bg !== null) {
        backgrounds.push(
          `<rect x="${coordinate(x)}" y="${coordinate(top)}" width="${coordinate(width)}" height="${String(TERMINAL_ROW_HEIGHT)}" fill="${run.bg}"/>`,
        )
      }
      // Whitespace draws nothing; a background-only run is already its rect.
      if (clipped.trim() !== '') {
        const fill = run.fg === null ? '' : ` fill="${run.fg}"`
        const weight = run.bold ? ' font-weight="bold"' : ''
        texts.push(
          `<text xml:space="preserve" x="${coordinate(x)}" y="${coordinate(baseline)}" textLength="${coordinate(width)}" lengthAdjust="spacingAndGlyphs"${fill}${weight}>${escapeXml(clipped)}</text>`,
        )
      }
      column += columns
    }
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(
    TERMINAL_CAMERA_WIDTH,
  )}" height="${String(TERMINAL_CAMERA_HEIGHT)}"><rect width="100%" height="100%" fill="${TERMINAL_DEFAULT_BG}"/>${backgrounds.join('')}<g fill="${TERMINAL_DEFAULT_FG}" font-family="${TERMINAL_FONT_STACK}" font-size="${String(TERMINAL_FONT_SIZE)}">${texts.join('')}</g></svg>`
}

/** Cut a run to the columns still left in the row, by code point not unit. */
function clipRun(run: TerminalCellRun, remaining: number): string {
  const points = [...run.text]
  return points.length <= remaining ? run.text : points.slice(0, remaining).join('')
}

export async function renderTerminalJpeg(rows: readonly TerminalStyledRow[]): Promise<Buffer> {
  return sharp(Buffer.from(renderTerminalSvg(rows)))
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0' })
    .toBuffer()
}
