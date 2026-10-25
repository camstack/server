#!/usr/bin/env tsx
/**
 * Clip refusal-header guard — **a reason that travels in an HTTP header goes
 * through `clipReasonHeaderValue` first.**
 *
 * ## The failure this catches
 *
 * An HTTP header value is Latin-1. Node throws `Invalid character in header
 * content` on anything above U+00FF, and it throws INSIDE the response
 * handler: the status is never written, the socket hangs, and the client sees
 * nothing at all.
 *
 * Measured on the live fleet, 2026-09-23. Camera 1436 refused a replay, the
 * provider built the honest sentence
 *
 *     SETUP of the video track answered 500 — the camera refused this replay
 *
 * and the EM DASH in it killed every clip the operator opened. The surface
 * reported "nothing happens"; the reason header — the one mechanism that
 * exists to say WHY a clip did not play — was itself the thing that silenced
 * it, on every vendor, for every refusal.
 *
 * This repository writes its refusals in prose, and its prose uses `—`, `’`
 * and `…` throughout. So this is not a typo that was fixed once: every future
 * reason string is a candidate, and a reviewer cannot see the difference
 * between a safe sentence and a fatal one by looking at it.
 *
 * ## What it checks
 *
 * Every assignment to `CLIP_STILL_REASON_HEADER` under `packages/` (excluding
 * tests and build output) must have `clipReasonHeaderValue(` on the same line.
 * `.slice(0, 500)` — what all five call sites used to do — is called out by
 * name, because it LOOKS like sanitising and bounds the wrong thing.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { globSync } from 'node:fs'

const ROOT = join(import.meta.dirname, '..')
const HEADER = 'CLIP_STILL_REASON_HEADER'
const HELPER = 'clipReasonHeaderValue('

interface Offence {
  readonly file: string
  readonly line: number
  readonly text: string
}

function sourceFiles(): readonly string[] {
  return globSync('packages/*/src/**/*.ts', { cwd: ROOT })
    .filter((f) => !f.includes('__tests__') && !f.includes('/dist/'))
    .map((f) => join(ROOT, f))
}

function offencesIn(file: string): readonly Offence[] {
  const out: Offence[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((text, i) => {
    // An ASSIGNMENT to the header, not an import or a read.
    if (!text.includes(`[${HEADER}]:`)) return
    if (text.includes(HELPER)) return
    out.push({ file: relative(ROOT, file), line: i + 1, text: text.trim() })
  })
  return out
}

const offences = sourceFiles().flatMap(offencesIn)
let written = 0
for (const file of sourceFiles()) {
  written += readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes(`[${HEADER}]:`)).length
}

if (offences.length > 0) {
  console.error(`✘ a clip refusal reason is written to a header without ${HELPER.slice(0, -1)}:`)
  for (const o of offences) {
    console.error(`    ${o.file}:${String(o.line)}`)
    console.error(`      ${o.text}`)
  }
  console.error('\n  An HTTP header value is Latin-1. A `—`, `’` or `…` in the sentence throws')
  console.error('  inside the handler and the client gets a socket hang up — no status, no reason.')
  console.error(`  Wrap the value: [${HEADER}]: ${HELPER}reason)`)
  console.error('  `.slice(0, 500)` is NOT enough: it bounds the length, not the alphabet.')
  process.exit(1)
}

console.log(`  ✔ ${String(written)} clip reason header write(s) go through ${HELPER.slice(0, -1)}`)
