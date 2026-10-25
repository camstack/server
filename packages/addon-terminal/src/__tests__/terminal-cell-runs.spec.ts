import { describe, expect, it } from 'vitest'
import {
  TERMINAL_DEFAULT_BG,
  TERMINAL_DEFAULT_FG,
  type TerminalStyledRow,
} from '../terminal-cell-runs.js'
import { createXtermScreen } from '../xterm-screen.js'

/** Write one escape-bearing line into a real vt and read back its first row. */
async function firstRow(data: string, cols = 40): Promise<TerminalStyledRow> {
  const screen = createXtermScreen(cols, 4)
  screen.write(data)
  await screen.flush()
  const row = screen.styledLines()[0] ?? []
  screen.dispose()
  return row
}

describe('terminal cell run extraction', () => {
  it('emits one default run for a line with no attributes', async () => {
    const row = await firstRow('plain text')

    expect(row).toEqual([{ text: 'plain text', fg: null, bg: null, bold: false }])
  })

  /**
   * Glances on the hub paints its whole screen with 16-colour SGR — measured
   * `CSI 32m` ×104 in a single frame. The renderer was monochrome by
   * construction, so every one of those was thrown away at the cell read.
   */
  it('splits a coloured run from the default text around it', async () => {
    const row = await firstRow('\x1b[32mOK\x1b[0m plain')

    expect(row).toEqual([
      { text: 'OK', fg: '#98c379', bg: null, bold: false },
      { text: ' plain', fg: null, bg: null, bold: false },
    ])
  })

  /**
   * The run merge IS the size bound on the SVG: without it a 120×40 screen
   * emits 4800 elements per frame at 2fps regardless of how little colour it
   * actually uses.
   */
  it('merges adjacent cells that resolve to the same style', async () => {
    const row = await firstRow('\x1b[32mAAAAAAAA\x1b[0m')

    expect(row).toHaveLength(1)
    expect(row[0]?.text).toBe('AAAAAAAA')
  })

  it('keeps a background run but trims the trailing default padding', async () => {
    const row = await firstRow('\x1b[42m  \x1b[0m   ')

    expect(row).toEqual([{ text: '  ', fg: null, bg: '#98c379', bold: false }])
  })

  /**
   * xterm.js already distinguishes palette 0-7 from 8-15, so bold is a weight,
   * not a second way to spell "bright". Remapping it would silently recolour
   * every bold-on-normal run Glances draws.
   */
  it('carries bold as a weight without remapping the palette to bright', async () => {
    const row = await firstRow('\x1b[0;1;32mBOLD')

    expect(row[0]).toEqual({ text: 'BOLD', fg: '#98c379', bg: null, bold: true })
  })

  it('resolves a 256-colour cube index', async () => {
    const row = await firstRow('\x1b[38;5;196mX')

    expect(row[0]?.fg).toBe('#ff0000')
  })

  it('resolves a 256-colour grayscale ramp index', async () => {
    const row = await firstRow('\x1b[38;5;232mX')

    expect(row[0]?.fg).toBe('#080808')
  })

  it('passes a truecolor foreground through unchanged', async () => {
    const row = await firstRow('\x1b[38;2;18;52;86mX')

    expect(row[0]?.fg).toBe('#123456')
  })

  /** Inverse of two defaults is still a visible swap, not a no-op. */
  it('swaps the resolved pair for inverse over defaults', async () => {
    const row = await firstRow('\x1b[7mX')

    expect(row[0]).toEqual({
      text: 'X',
      fg: TERMINAL_DEFAULT_BG,
      bg: TERMINAL_DEFAULT_FG,
      bold: false,
    })
  })

  it('swaps the resolved pair for inverse over an explicit colour', async () => {
    const row = await firstRow('\x1b[7;32mX')

    expect(row[0]).toEqual({ text: 'X', fg: TERMINAL_DEFAULT_BG, bg: '#98c379', bold: false })
  })

  /** Conceal is fg-equals-bg, not "drop the cell" — the columns must stay. */
  it('conceals invisible text by painting it in its own background', async () => {
    const row = await firstRow('\x1b[8;41mhidden')

    expect(row[0]?.bg).toBe('#e06c75')
    expect(row[0]?.fg).toBe('#e06c75')
  })

  it('dims a foreground toward the background without hiding it', async () => {
    const row = await firstRow('\x1b[2;32mdim')
    const fg = row[0]?.fg

    expect(fg).not.toBe('#98c379')
    expect(fg).not.toBe(TERMINAL_DEFAULT_BG)
    // 60% of the green (152,195,121), 40% of the default background (11,13,16).
    expect(fg).toBe('#607a4f')
  })

  /** getCell returns a zero-width tail for the second half of a wide glyph. */
  it('keeps a wide character once, without its zero-width tail', async () => {
    const row = await firstRow('\x1b[32m日本\x1b[0m')

    expect(row).toEqual([{ text: '日本', fg: '#98c379', bg: null, bold: false }])
  })

  it('returns an empty row for a blank line', async () => {
    const row = await firstRow('')

    expect(row).toEqual([])
  })

  /**
   * `lines()` still backs the snapshot/serialisation consumers, so the styled
   * reader must agree with it character for character or the two views of the
   * same screen drift. (They part company only on trailing whitespace that
   * carries a background — which the styled reader keeps deliberately, because
   * a green bar of spaces to the right margin IS the pixel Glances drew.)
   */
  it('agrees with the plain reader on the text it carries', async () => {
    const screen = createXtermScreen(40, 4)
    screen.write('\x1b[32mCPU\x1b[0m  12%\x1b[41mLOW\x1b[0m')
    await screen.flush()
    const plain = screen.lines()[0]
    const joined = (screen.styledLines()[0] ?? []).map((run) => run.text).join('')
    screen.dispose()

    expect(joined).toBe(plain)
  })
})
