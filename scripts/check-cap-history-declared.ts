#!/usr/bin/env tsx
/**
 * Cap history guard (D850) — a value is recorded as long-term history because
 * its own capability said so, in a diff someone reviewed.
 *
 * Rules, judged by `scripts/lib/cap-history.ts` against the real Zod schemas:
 *   1. A cap declaring `runtimeState` MUST declare `history` — `'none'` is an
 *      explicit answer, silence is not.
 *   2. A cap without `runtimeState` declares no `history`.
 *   3. Every named field resolves through FIXED objects (`a.b`) — never into an
 *      array, record, tuple or union keyed by runtime ids.
 *   4. Its schema unwraps (optional / nullable / default) to a number or a
 *      boolean, and `kind: 'boolean'` holds exactly for a boolean.
 *   5. It is not a clock in `volatileStateFields`.
 *   6. `unit` xor `unitFrom`; `unitFrom` names a sibling string or enum field;
 *      `excludeDeviceTypes` are real `DeviceType`s; option values are sane.
 *
 * Run: npx tsx scripts/check-cap-history-declared.ts
 */

import { judgeCapHistory, loadHistoryCaps } from './lib/cap-history.ts'

async function main(): Promise<void> {
  const caps = await loadHistoryCaps()
  const violations = caps.flatMap((cap) => judgeCapHistory(cap))
  if (violations.length === 0) {
    const withSeries = caps.filter((c) => c.history !== undefined && c.history !== 'none').length
    // eslint-disable-next-line no-console
    console.log(`✔ cap history: ${caps.length} caps, ${withSeries} with series, all declared`)
    return
  }
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ cap history guard failed\x1b[0m')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`    - ${v.capName}${v.field ? `.${v.field}` : ''} [${v.rule}] ${v.message}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

void main()
