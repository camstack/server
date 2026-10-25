/**
 * Real {@link ScreenBuffer} backed by `@xterm/headless` — the DOM-less xterm
 * build — plus the serialize addon, which turns the current buffer into a
 * self-contained repaint escape sequence for reconnecting clients.
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import {
  buildCellRuns,
  resolveCellStyle,
  type TerminalStyledCell,
  type TerminalStyledRow,
} from './terminal-cell-runs.js'
import type { ScreenBuffer } from './terminal-session-manager.js'

const SCROLLBACK_LINES = 2000

export function createXtermScreen(cols: number, rows: number): ScreenBuffer {
  const term = new Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
  })
  const serialize = new SerializeAddon()
  term.loadAddon(serialize)
  let pendingWrite = Promise.resolve()

  return {
    write: (data: string) => {
      pendingWrite = new Promise<void>((resolve) => term.write(data, resolve))
    },
    flush: () => pendingWrite,
    resize: (nextCols: number, nextRows: number) => {
      term.resize(nextCols, nextRows)
    },
    snapshot: () => serialize.serialize(),
    lines: () => {
      const buffer = term.buffer.active
      const lines: string[] = []
      for (let row = 0; row < term.rows; row += 1) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
      }
      return lines
    },
    /**
     * The colour-bearing read. `translateToString` — the only cell read this
     * screen used to offer — keeps characters and discards every attribute,
     * which is why the terminal camera rendered a fully-coloured Glances in
     * grey. Walking cells is the only way to get the attributes back.
     *
     * A zero-width cell is the tail half of a wide glyph (CJK, some emoji);
     * its characters already came back with the leading cell, so skipping it
     * keeps the text right. `getNullCell()` is reused across the whole screen
     * because `getCell` allocates otherwise — 4800 objects per frame.
     */
    styledLines: () => {
      const buffer = term.buffer.active
      const scratch = buffer.getNullCell()
      const styled: TerminalStyledRow[] = []
      for (let row = 0; row < term.rows; row += 1) {
        const line = buffer.getLine(buffer.viewportY + row)
        if (!line) {
          styled.push([])
          continue
        }
        const cells: TerminalStyledCell[] = []
        for (let column = 0; column < line.length; column += 1) {
          const cell = line.getCell(column, scratch)
          if (!cell || cell.getWidth() === 0) continue
          cells.push({ text: cell.getChars() || ' ', style: resolveCellStyle(cell) })
        }
        styled.push(buildCellRuns(cells))
      }
      return styled
    },
    dispose: () => {
      term.dispose()
    },
  }
}
