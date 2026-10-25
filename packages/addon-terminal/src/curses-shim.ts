/**
 * macOS repair for the managed Python's curses.
 *
 * The python-build-standalone distribution the dependency resolver installs on
 * macOS links ncurses statically with the terminfo database compiled OUT
 * (`--disable-database`) and an ABI mismatch that misparses every numeric
 * capability of its five built-in fallback terminals (`colors=-1`,
 * `cols=524368`). `has_colors()` is therefore False under every TERM value and
 * `init_pair` is hard-blocked, so glances takes its B&W branch and paints the
 * whole screen with SGR conceal/reverse/alt-charset — the "text missing,
 * light bars instead" terminal camera frames. No environment variable can fix
 * it: the code that would read TERMINFO/TERMINFO_DIRS was never compiled in.
 *
 * The repair ships prebuilt `_curses` / `_curses_panel` extension modules
 * linked against the system `/usr/lib/libncurses.5.4.dylib` (universal2) and
 * puts their directory on PYTHONPATH at PTY spawn — PYTHONPATH precedes
 * lib-dynload on sys.path, so the working modules shadow the broken ones with
 * no change to the managed distribution. The filename is ABI-locked to
 * cpython-312: a managed-python bump to 3.13 makes the shim silently inert
 * (python ignores a mismatched ABI tag), which is why the addon probes
 * `tigetnum("colors")` at startup and logs loudly when colours are missing.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CursesShimEnvOptions {
  readonly platform: NodeJS.Platform
  readonly shimDir: string
  readonly shimDirExists: boolean
  readonly existingPythonPath?: string
}

/** `<addonRoot>/assets/curses-shim/py312`, valid from both src/ and dist/. */
export function cursesShimDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'assets',
    'curses-shim',
    'py312',
  )
}

export function cursesShimDirExists(shimDir: string): boolean {
  return existsSync(shimDir)
}

/**
 * The env to merge into the glances profile, or undefined when the shim does
 * not apply (non-macOS, or the assets were not shipped).
 */
export function resolveGlancesCursesShimEnv(
  options: CursesShimEnvOptions,
): Readonly<Record<string, string>> | undefined {
  if (options.platform !== 'darwin' || !options.shimDirExists) return undefined
  const existing = options.existingPythonPath?.trim()
  return {
    PYTHONPATH: existing ? `${options.shimDir}:${existing}` : options.shimDir,
  }
}
