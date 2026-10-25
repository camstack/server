export { TerminalAddon } from './addon.js'
export { TerminalAddon as default } from './addon.js'
export {
  TerminalSessionManager,
  type ScreenBuffer,
  type ScreenFactory,
  type TerminalOutputEvent,
  type TerminalOutputSink,
  type TerminalSessionManagerOptions,
} from './terminal-session-manager.js'
export { buildProfiles, findProfile, type TerminalProfile } from './profiles.js'
export {
  buildCellRuns,
  resolveCellStyle,
  terminalPaletteColor,
  terminalRgbColor,
  TERMINAL_DEFAULT_BG,
  TERMINAL_DEFAULT_FG,
  type TerminalCellAttributes,
  type TerminalCellRun,
  type TerminalCellStyle,
  type TerminalStyledCell,
  type TerminalStyledRow,
} from './terminal-cell-runs.js'
export {
  createNodePtySpawner,
  warmNodePty,
  type PtyProcess,
  type PtySpawner,
  type PtySpawnOptions,
} from './pty.js'
export { createTerminalDataPlaneHandler } from './terminal-data-plane.js'
export { createXtermScreen } from './xterm-screen.js'
