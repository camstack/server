#!/usr/bin/env tsx
/**
 * Public-docs staleness reminder — lists public docs pages whose described server code changed after they were verified.
 *
 * NOT a gate (D751). The public site lives in another repository
 * (`camstack/docs`, Next.js + fumadocs), so the internal drift guard never saw
 * it, and pages there described models, engines and tools that had moved on the
 * server for days with nothing saying so. Each page now declares the server code
 * it describes in its frontmatter — `applies-to:` (verified, arms this
 * reminder) and/or `covers:` (claims only), the same keys and meaning as the
 * internal docs (D145) — plus `last-verified: YYYY-MM-DD`.
 *
 * Reports:
 *   1. pages whose `applies-to` code has non-release commits newer than the
 *      page's `last-verified` (or, without one, the page's last commit), with
 *      the newest of those commits;
 *   2. pages that claim nothing at all (the coverage gap);
 *   3. claimed globs that match no tracked file (dead).
 *
 * Globs are relative to camstack-server; a `camstack/…` glob is the viewer
 * submodule, judged in the viewer's own history.
 *
 * The docs checkout is `CAMSTACK_DOCS_DIR`, else `../docs` beside this repo; when
 * neither exists the script says so and exits 0.
 *
 * Exit code is ALWAYS 0 unless `--strict` (then 1 on any stale or dead page).
 * It is deliberately not in the commit hook nor in a workflow: it is read at the
 * end of a piece of work (the `camstack-docs` skill), not enforced on it.
 *
 * Usage:
 *   npm run docs:public-stale
 *   npm run docs:public-stale -- --strict
 *   npm run docs:public-stale -- --commits 10
 */
import * as path from 'node:path'
import { DEFAULT_COMMITS_SHOWN, locateDocs, run } from './lib/public-docs-staleness.js'

const ROOT = path.resolve(import.meta.dirname, '..')

function commitsArg(argv: readonly string[]): number {
  const index = argv.indexOf('--commits')
  if (index < 0) return DEFAULT_COMMITS_SHOWN
  const value = Number(argv[index + 1])
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_COMMITS_SHOWN
}

function main(): void {
  const result = run({
    serverRoot: ROOT,
    docsRoot: locateDocs(ROOT, process.env),
    viewerRoot: process.env['CAMSTACK_VIEWER_DIR'] ?? path.join(ROOT, 'camstack'),
    strict: process.argv.includes('--strict'),
    commitsShown: commitsArg(process.argv),
  })
  for (const line of result.lines) console.log(line)
  process.exit(result.exitCode)
}

main()
