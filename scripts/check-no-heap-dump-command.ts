/**
 * There is NO operator-triggerable heap dump. Twice is enough.
 *
 * `metricsProvider.dumpHeapSnapshot` signalled a runner to serialise its V8
 * heap to disk. On a 1.8 GB heap that is a stop-the-world pause plus a
 * multi-gigabyte write, and the runner it was most useful against — the
 * recorder — is central to the pipeline. Both times it was reached for, the hub
 * stopped answering: SSH timed out during banner exchange while the host still
 * answered ping, which is the signature of a machine too loaded to fork.
 *
 * The second time was 2026-09-03 and the operator's instruction was explicit:
 * remove it completely.
 *
 * What is lost is real and worth stating: the recorder retains ~900 MB of large
 * objects that no allocation site in its tree can account for, and a heap
 * snapshot is the only thing that names them. That investigation now needs a
 * recorder that is not serving cameras — a spare node, or a copy of the process
 * — rather than a button that can be pressed against production.
 *
 * This guard exists because the capability is easy to re-add innocently: it is
 * a small method on a metrics cap, and its danger is not visible at the call
 * site.
 */
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

// The command AND the writer. `check-heap-snapshot-is-gated.ts` used to own the
// writer, requiring it to sit behind an env flag — but the flag was the whole
// failure: it was set `on` in production, so the lock was open and one signal
// was enough. A guard that says "it must be gated" is the wrong guard once the
// answer is "it must not exist", and leaving it would have made a correctly
// gated re-addition PASS. It is deleted; this owns both.
const BANNED = /dumpHeapSnapshot|DumpHeapSnapshot|writeHeapSnapshot/

const files = globSync('{packages,server,scripts}/**/*.{ts,tsx}', {
  exclude: (p) =>
    p.includes('node_modules') ||
    p.includes('/dist/') ||
    p.endsWith('check-no-heap-dump-command.ts'),
})

const offenders: string[] = []
for (const file of files) {
  const text = readFileSync(file, 'utf-8')
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    // A COMMENT naming it is the record of why it is gone — that must survive,
    // or the next person re-adds it for the same reason the first one did.
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
    if (BANNED.test(line)) offenders.push(`${file}:${String(i + 1)}: ${trimmed}`)
  })
}

if (offenders.length > 0) {
  console.error(
    '✘ heap-dump guard: a heap snapshot command is back.\n' +
      '  It took the hub down twice (2026-08 and 2026-09-03) — a stop-the-world\n' +
      '  serialisation of a multi-GB heap on the process that runs recording.\n' +
      '  Profile a recorder that is NOT serving cameras instead.\n',
  )
  for (const o of offenders) console.error(`    ${o}`)
  process.exit(1)
}
console.log('  ✔ no heap dump — neither the remote command nor the writer (removed 2026-09-03)')
