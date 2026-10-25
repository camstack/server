#!/usr/bin/env tsx
/**
 * A broker packet is written to a socket only through `writeHeld` (D868).
 *
 * A packet is a view of a recycled slab; a `socket.write(packet)` that Node
 * queues behind a full kernel buffer reads recycled memory when the peer drains
 * (a header promising N bytes, then zeros) and leaves `writableLength`
 * inflated. `writeHeld` (`stream-broker/stream-broker/held-write.ts`) holds the
 * slab until the write callback. Scope: runtime source under
 * `packages/addon-pipeline/src/stream-broker`, excluding specs and
 * `held-write.ts`. Flags `<x>.write(` / `.writev(` whose first argument is an
 * identifier named like a packet (`payload`, `packet`, `pkt`, `rtp…`).
 * Textual: a differently named variable passes, which is why the rule also
 * lives in `slab-pool.ts`'s header.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = 'packages/addon-pipeline/src/stream-broker'
const ALLOWED = new Set([`${SCOPE}/stream-broker/held-write.ts`])
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'generated'])
const PACKET_WRITE = /\b[A-Za-z_.]*\.(?:write|writev)\(\s*(?:payload|packet|pkt|rtp\w*)\b/

export function findViolations(file: string, text: string): string[] {
  const out: string[] = []
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    if (PACKET_WRITE.test(line)) out.push(`${file}:${i + 1}: ${trimmed}`)
  })
  return out
}

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, acc)
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      acc.push(full)
    }
  }
}

function main(): void {
  const files: string[] = []
  walk(path.join(ROOT, SCOPE), files)
  const violations: string[] = []
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    if (ALLOWED.has(rel)) continue
    violations.push(...findViolations(rel, readFileSync(abs, 'utf8')))
  }
  if (violations.length > 0) {
    console.error('A broker packet is written to a socket without a hold (use writeHeld, D868):')
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log(`slab writes held: ${files.length} files clean`)
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
}
