#!/usr/bin/env tsx
/**
 * The LLM library may be imported from ONE directory, and a model is never a
 * bare string.
 *
 * Two rules, both of which exist because the failure is silent:
 *
 * 1. **`ai` / `@ai-sdk/*` only under `packages/addon-ai/src/client/`.** The
 *    library ships a major roughly every six months with wide renames
 *    (`system`→`instructions`, `onFinish`→`onEnd`, restructured usage fields).
 *    Behind the `LlmClient` seam that upgrade costs one file; a second importer
 *    anywhere makes it cost the addon. Nothing fails at build time when the
 *    boundary leaks — it just quietly stops being a boundary.
 *
 * 2. **No bare model-id string passed to `generateText` / `streamText`.**
 *    `@ai-sdk/gateway` is a hard dependency of `ai@7`, and `model: 'openai/x'`
 *    routes the call to `https://ai-gateway.vercel.sh` instead of the operator's
 *    endpoint, failing with `Unauthenticated request to AI Gateway`. A profile's
 *    endpoint would be silently ignored. Always a provider INSTANCE.
 *
 * Wired into `.github/workflows/ci.yml`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ALLOWED_DIR = 'packages/addon-ai/src/client/'

/** `from 'ai'`, `from "@ai-sdk/openai"`, `require('ai')`, `import('ai')`. */
const LIBRARY_IMPORT = /(?:from|require\s*\(|import\s*\()\s*['"](ai|@ai-sdk\/[a-z0-9-]+)['"]/g

/** `model: 'anything'` — a string literal where a provider instance belongs. */
const BARE_MODEL_STRING = /\bmodel\s*:\s*['"`]/g

interface Violation {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly text: string
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/**
 * Tracked sources only. `git ls-files` is both the correct set (a file nobody
 * committed cannot break CI) and fast — a recursive glob over this monorepo
 * spends minutes descending into node_modules and dist.
 */
function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((f) => f.length > 0 && !f.includes('/dist/'))
}

function main(): void {
  const violations: Violation[] = []

  for (const entry of trackedSources()) {
    const rel = entry.split('\\').join('/')
    const abs = resolve(REPO_ROOT, entry)
    // This guard names the library in its own prose; skip itself.
    if (rel === 'scripts/check-llm-library-boundary.ts') continue
    // Tracked but deleted in the working tree — nothing to read, nothing to break.
    if (!existsSync(abs)) continue
    const source = readFileSync(abs, 'utf8')

    if (!rel.startsWith(ALLOWED_DIR)) {
      for (const match of source.matchAll(LIBRARY_IMPORT)) {
        violations.push({
          file: rel,
          line: lineOf(source, match.index),
          rule: `imports "${match[1]}" outside ${ALLOWED_DIR}`,
          text: match[0].trim(),
        })
      }
      continue
    }

    // Inside the allowed directory the second rule applies.
    if (!/generateText|streamText/.test(source)) continue
    for (const match of source.matchAll(BARE_MODEL_STRING)) {
      violations.push({
        file: rel,
        line: lineOf(source, match.index),
        rule: 'bare model-id string routes through the Vercel AI Gateway — pass a provider instance',
        text: match[0].trim(),
      })
    }
  }

  if (violations.length === 0) {
    console.log('✓ LLM library boundary intact')
    return
  }

  console.error(`\n✗ ${String(violations.length)} LLM library boundary violation(s):\n`)
  for (const v of violations) {
    console.error(`  ${v.file}:${String(v.line)}`)
    console.error(`    ${v.rule}`)
    console.error(`    → ${v.text}\n`)
  }
  console.error(
    `The library is allowed only in ${ALLOWED_DIR} (the LlmClient seam).\n` +
      'See docs/design/llm-library-adoption.md §3.\n',
  )
  process.exit(1)
}

main()
