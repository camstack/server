#!/usr/bin/env tsx
/**
 * Drain-listener guard (D618) — a one-shot drain listener may only be
 * registered from the path that was REFUSED, never once at setup.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `ClipStreamRouteSink.onceDrain` is `res.once('drain', …)`: firing CONSUMES
 * the listener. D447's gate arms on a `write()` that returns `false` and can
 * only be disarmed by `drain`. Register that listener a single time, at spawn,
 * and the FIRST back-pressure episode uses it up — every later one arms a gate
 * nothing alive can disarm, and the stream is cut for "a peer that stopped
 * taking bytes" while bytes are still flowing through it.
 *
 * Measured on Hikvision camera 1436 on 2026-09-23: `peer-stalled` at elapsedMs
 * 11 176 / 11 265 / 11 286 / 11 301 across four attempts by the operator — a
 * 125 ms spread over four different clips, which is a fixed timer and never
 * content. 4 679 321 bytes and 137 access units had been delivered. Reolink
 * and Amcrest re-registered per refusal and were unaffected, which is why the
 * defect looked like a Hikvision media problem for a day.
 *
 * ── What this guard does ───────────────────────────────────────────────────
 * Every `onceDrain(` CALL site (not the interface member and not the sink
 * literal that implements it) must have a `.write(` within the preceding
 * window — i.e. it is registered from the write path that was just refused.
 * A registration at spawn has no write above it and is flagged.
 *
 * Run manually: npx tsx scripts/check-drain-listener-rearmed.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PACKAGES = path.join(ROOT, 'packages')

/** How far above a registration the refused write may sit, in characters of
 *  code — whitespace and comments stripped. Reolink's is the longest real one
 *  at ~80; 400 leaves room without letting a registration drift to setup. */
const WRITE_WINDOW_CHARS = 400

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      if (entry.name === '__tests__') continue
      sourceFiles(full, out)
    } else if (entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Blank every comment, in place, keeping length and newlines.
 *
 * The window below is measured in CHARACTERS of code. A rationale paragraph
 * above a registration is not distance — left in, it pushed the write out of
 * view and this guard flagged the very fix that motivated it, which is the
 * lesson `check-runner-barrel-free.ts` already had to learn.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, ' '))
}

function violations(file: string): Violation[] {
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  const found: Violation[] = []
  let at = -1
  while ((at = src.indexOf('onceDrain', at + 1)) !== -1) {
    const after = src.slice(at + 'onceDrain'.length, at + 'onceDrain'.length + 2)
    // `onceDrain(listener: () => void): void` — the interface member.
    // `onceDrain: (listener) => {` — the sink literal implementing it.
    // Only `…onceDrain(` preceded by a `.` is a REGISTRATION.
    if (!after.startsWith('(')) continue
    if (src[at - 1] !== '.') continue
    // The budget is characters of CODE. Comments were blanked above, and the
    // blanks — like the indentation — must not count as distance either, or a
    // rationale paragraph pushes the write it explains out of view.
    const window = src.slice(0, at).replace(/\s+/g, '').slice(-WRITE_WINDOW_CHARS)
    if (window.includes('.write(')) continue
    found.push({
      file: path.relative(ROOT, file),
      line: src.slice(0, at).split('\n').length,
      text: src.slice(at, src.indexOf('\n', at)).trim(),
    })
  }
  return found
}

const all = sourceFiles(PACKAGES).flatMap(violations)
if (all.length > 0) {
  console.error('✘ A drain listener is registered away from the write it answers (D618):\n')
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`)
  }
  console.error(
    '\n  `onceDrain` is `res.once`: firing consumes the listener. Register it inside the',
  )
  console.error('  branch that handled a refused `write()`, so every episode gets its own.\n')
  process.exit(1)
}
console.log('✓ every drain listener is registered from the write it answers (D618)')
