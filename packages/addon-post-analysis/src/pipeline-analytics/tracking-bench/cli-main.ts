/**
 * Process entry for `npm run tracking-bench -w packages/addon-post-analysis`.
 * Kept apart from `cli.ts` so the specs import `runCli` without running it.
 * No top-level await: the package is not `"type": "module"`, and tsx runs it
 * as CommonJS.
 */
import { CASES_DIR } from './cases/case-fixture.js'
import { runCli } from './cli.js'

void runCli(
  process.argv.slice(2),
  {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
  },
  { casesDir: CASES_DIR },
).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exitCode = 1
  },
)
