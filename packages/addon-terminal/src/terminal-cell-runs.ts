/**
 * Styled cell runs — the colour-bearing view of a terminal screen.
 *
 * The camera used to read the screen through `translateToString`, which keeps
 * characters and throws every attribute away. Glances on the hub paints almost
 * entirely with 16-colour SGR (measured 2026-08-12: `CSI 32m` ×104, `CSI 42m`,
 * `CSI 0;1m` in a single frame), so the camera was monochrome by construction —
 * exactly the operator's report, "glances works but the COLOURS are missing".
 *
 * A run is a maximal span of adjacent cells that resolve to the same style.
 * That merge is not an optimisation, it is the SIZE BOUND on the rendered SVG:
 * a 120×40 screen is 4800 cells, and a per-cell element would put 4800 of them
 * into every frame at 2fps.
 *
 * This module deliberately holds no `@xterm/*` import — it takes the read-only
 * attribute surface structurally ({@link TerminalCellAttributes}), so the
 * resolution rules can be tested without a vt and `IBufferCell` satisfies it
 * without a cast.
 */

/** One run of adjacent cells sharing a resolved style. `null` = the default. */
export interface TerminalCellRun {
  readonly text: string
  readonly fg: string | null
  readonly bg: string | null
  readonly bold: boolean
}

/** One visible screen row, left to right. */
export type TerminalStyledRow = readonly TerminalCellRun[]

/** The resolved style of a single cell, before runs are merged. */
export interface TerminalCellStyle {
  readonly fg: string | null
  readonly bg: string | null
  readonly bold: boolean
}

/** One cell's text plus its resolved style. */
export interface TerminalStyledCell {
  readonly text: string
  readonly style: TerminalCellStyle
}

/**
 * The read-only subset of xterm's `IBufferCell` the extractor needs. Declared
 * structurally so `IBufferCell` satisfies it directly — no cast, and no vt
 * required to test the resolution rules.
 */
export interface TerminalCellAttributes {
  isFgDefault(): boolean
  isBgDefault(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgRGB(): boolean
  isBgRGB(): boolean
  getFgColor(): number
  getBgColor(): number
  isBold(): number
  isInverse(): number
  isInvisible(): number
  isDim(): number
}

export const TERMINAL_DEFAULT_FG = '#d7dce2'
export const TERMINAL_DEFAULT_BG = '#0b0d10'

/**
 * The 16 ANSI colours, in a dark-theme variant chosen to sit with the existing
 * frame (`#0b0d10` ground, `#d7dce2` text) rather than the raw xterm defaults,
 * whose pure `#0000ff` blue and `#008000` green are close to unreadable on a
 * near-black background at 13px. Index 7 IS the default foreground, so plain
 * `CSI 37m` text renders identically to unstyled text.
 */
const TERMINAL_ANSI_PALETTE: readonly string[] = [
  '#282c34', // 0 black
  '#e06c75', // 1 red
  '#98c379', // 2 green
  '#e5c07b', // 3 yellow
  '#61afef', // 4 blue
  '#c678dd', // 5 magenta
  '#56b6c2', // 6 cyan
  TERMINAL_DEFAULT_FG, // 7 white
  '#5c6370', // 8 bright black
  '#ef596f', // 9 bright red
  '#89ca78', // 10 bright green
  '#f0c674', // 11 bright yellow
  '#6cb6ff', // 12 bright blue
  '#d55fde', // 13 bright magenta
  '#2bbac5', // 14 bright cyan
  '#ffffff', // 15 bright white
]

/** The six levels of the xterm 6×6×6 colour cube (indices 16-231). */
const TERMINAL_CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255]
const TERMINAL_CUBE_FIRST = 16
const TERMINAL_GRAYSCALE_FIRST = 232
const TERMINAL_GRAYSCALE_BASE = 8
const TERMINAL_GRAYSCALE_STEP = 10
/** SGR 2 keeps the foreground legible; it must not become the background. */
const TERMINAL_DIM_WEIGHT = 0.6

function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')
}

function hex(red: number, green: number, blue: number): string {
  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function parseHex(color: string): readonly [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]
}

/** Resolve an xterm palette index (0-255) to a hex colour. */
export function terminalPaletteColor(index: number): string {
  const ansi = TERMINAL_ANSI_PALETTE[index]
  if (ansi !== undefined) return ansi
  if (index >= TERMINAL_GRAYSCALE_FIRST) {
    const level =
      TERMINAL_GRAYSCALE_BASE + (index - TERMINAL_GRAYSCALE_FIRST) * TERMINAL_GRAYSCALE_STEP
    return hex(level, level, level)
  }
  if (index >= TERMINAL_CUBE_FIRST) {
    const offset = index - TERMINAL_CUBE_FIRST
    const red = TERMINAL_CUBE_LEVELS[Math.floor(offset / 36) % 6] ?? 0
    const green = TERMINAL_CUBE_LEVELS[Math.floor(offset / 6) % 6] ?? 0
    const blue = TERMINAL_CUBE_LEVELS[offset % 6] ?? 0
    return hex(red, green, blue)
  }
  return TERMINAL_DEFAULT_FG
}

/** Resolve a 0xRRGGBB truecolor value to a hex colour. */
export function terminalRgbColor(value: number): string {
  return hex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
}

function blend(color: string, toward: string, weight: number): string {
  const [red, green, blue] = parseHex(color)
  const [targetRed, targetGreen, targetBlue] = parseHex(toward)
  return hex(
    red * weight + targetRed * (1 - weight),
    green * weight + targetGreen * (1 - weight),
    blue * weight + targetBlue * (1 - weight),
  )
}

function resolveForeground(cell: TerminalCellAttributes): string {
  if (cell.isFgRGB()) return terminalRgbColor(cell.getFgColor())
  if (cell.isFgPalette()) return terminalPaletteColor(cell.getFgColor())
  return TERMINAL_DEFAULT_FG
}

function resolveBackground(cell: TerminalCellAttributes): string {
  if (cell.isBgRGB()) return terminalRgbColor(cell.getBgColor())
  if (cell.isBgPalette()) return terminalPaletteColor(cell.getBgColor())
  return TERMINAL_DEFAULT_BG
}

/**
 * Resolve one cell's attributes into concrete colours.
 *
 * Inverse is applied by SWAPPING the already-resolved pair, so inverse over two
 * defaults is still a visible swap rather than a no-op — that is how a selected
 * or highlighted row in Glances reads. Invisible is then conceal-by-equality
 * (foreground painted in its own background): the cell keeps its columns, which
 * a dropped cell would not, and dropping it would shift the whole rest of the
 * row left.
 */
export function resolveCellStyle(cell: TerminalCellAttributes): TerminalCellStyle {
  const inverse = cell.isInverse() !== 0
  const plainFg = resolveForeground(cell)
  const plainBg = resolveBackground(cell)
  const background = inverse ? plainFg : plainBg
  let foreground = inverse ? plainBg : plainFg
  if (cell.isDim() !== 0) foreground = blend(foreground, background, TERMINAL_DIM_WEIGHT)
  if (cell.isInvisible() !== 0) foreground = background
  return {
    fg: foreground === TERMINAL_DEFAULT_FG ? null : foreground,
    bg: background === TERMINAL_DEFAULT_BG ? null : background,
    bold: cell.isBold() !== 0,
  }
}

function sameStyle(left: TerminalCellStyle, right: TerminalCellStyle): boolean {
  return left.fg === right.fg && left.bg === right.bg && left.bold === right.bold
}

/**
 * Merge adjacent same-style cells into runs, then drop the trailing run of
 * default-styled whitespace so a row costs what it draws — the same trim
 * `translateToString(true)` performs. Whitespace carrying a BACKGROUND is kept:
 * a green bar of spaces out to the right margin is a pixel Glances drew.
 */
export function buildCellRuns(cells: readonly TerminalStyledCell[]): TerminalStyledRow {
  const runs: TerminalCellRun[] = []
  let text = ''
  let style: TerminalCellStyle | null = null
  for (const cell of cells) {
    if (style !== null && sameStyle(style, cell.style)) {
      text += cell.text
      continue
    }
    if (style !== null) runs.push({ text, ...style })
    text = cell.text
    style = cell.style
  }
  if (style !== null) runs.push({ text, ...style })
  while (runs.length > 0) {
    const last = runs[runs.length - 1]
    // Only the default background is padding. The trim has to reach INSIDE the
    // final run too — a screen's last run is usually real text followed by the
    // rest of the row, so dropping only all-blank runs left every row padded
    // out to the full column count.
    if (last === undefined || last.bg !== null) break
    const trimmed = last.text.replace(/\s+$/u, '')
    if (trimmed === last.text) break
    if (trimmed === '') {
      runs.pop()
      continue
    }
    runs[runs.length - 1] = { ...last, text: trimmed }
    break
  }
  return runs
}
