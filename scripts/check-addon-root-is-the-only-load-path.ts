#!/usr/bin/env tsx
/**
 * Addon load-path guard — an addon is loaded ONLY from `<dataDir>/addons`.
 *
 * ## The failure this catches
 *
 * Eight addons are npm dependencies of `@camstack/server`, so every node has a
 * second copy of each inside the server closure. Nothing imports an addon from
 * there — `AddonLoader.loadFromDirectory` reads ONE directory with no fallback,
 * on the hub and on an agent alike — so those copies are inert, and the addon
 * root is the only place code actually runs from.
 *
 * "Inert" is the property the whole update story rests on, and it is invisible:
 * one `require.resolve('@camstack/addon-…')` added in good faith would give a
 * node two live copies whose winner depends on import order, and nothing in any
 * suite would notice. Measured 2026-09-17: the ONE consumer that did read an
 * addon out of the closure — the agent's static UI dist — served a build from a
 * different generation than the addon beside it, and that had been true long
 * enough that a "newest of the two wins" tie-breaker had grown around it.
 *
 * So the count of such resolutions is pinned, and it is pinned at zero. A
 * paragraph saying "the closure copy is inert" has no way to stay true.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { globSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where host code lives. A workspace package importing its own sibling in a
 *  test fixture is not a node resolving an addon at runtime. */
const ROOTS = ['server/backend/src', 'packages/system/src', 'packages/node-root/src'] as const

/**
 * Resolving an addon package by name — the shape that would give a node a
 * second live copy.
 */
const BY_NAME =
  /(?:require\.resolve|createRequire\([^)]*\)(?:\.resolve)?|await import|import\s*\()\s*[`'"]@camstack\/addon-[a-z-]+/g

/**
 * Reaching for a sibling `dist/` by path — how the agent's static UI ended up
 * being served out of the closure.
 */
const BY_PATH = /path\.(?:resolve|join)\([^)]*addon-[a-z-]+[^)]*dist/g

interface Finding {
  readonly file: string
  readonly line: number
  readonly text: string
}

function scan(pattern: RegExp): readonly Finding[] {
  const out: Finding[] = []
  for (const root of ROOTS) {
    let files: string[]
    try {
      files = globSync('**/*.ts', { cwd: join(ROOT, root) })
    } catch {
      continue
    }
    for (const rel of files) {
      if (rel.includes('__tests__') || rel.endsWith('.spec.ts')) continue
      const abs = join(ROOT, root, rel)
      const source = readFileSync(abs, 'utf8')
      const lines = source.split('\n')
      let inBlockComment = false
      lines.forEach((text, i) => {
        // A COMMENT resolves nothing, and the record of a removal names the
        // shape it removed — the first thing this guard flagged after the fix
        // was the sentence explaining the fix.
        const trimmed = text.trim()
        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false
          return
        }
        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlockComment = true
          return
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return

        pattern.lastIndex = 0
        if (pattern.test(text)) {
          out.push({ file: relative(ROOT, abs), line: i + 1, text: text.trim().slice(0, 140) })
        }
      })
    }
  }
  return out
}

const byName = scan(BY_NAME)
const byPath = scan(BY_PATH)
const findings = [...byName, ...byPath]

if (findings.length > 0) {
  console.error(
    `✖ an addon is resolved outside <dataDir>/addons — the closure copy must stay inert (D518):`,
  )
  for (const f of findings) console.error(`    ${f.file}:${f.line}  ${f.text}`)
  console.error(
    `\n  If a node needs an addon's files, it takes them from the addon root, which is\n` +
      `  where every role loads addons from. A second live copy has no tie-breaker\n` +
      `  worth trusting — the one that grew around the agent UI picked by mtime.`,
  )
  process.exit(1)
}

console.log(
  `  ✔ addon load path: ${ROOTS.length} host roots, 0 addons resolved outside the addon root`,
)
