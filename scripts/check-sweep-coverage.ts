#!/usr/bin/env tsx
/**
 * Sweep-coverage guard — a paged bulk sweep covers the WHOLE collection, or it
 * covers the head and SAYS so (D480).
 *
 * ## The failure this catches
 *
 * The orphan audit was correctly wired, ran every six hours in `reclaim` mode,
 * and had never examined 96 % of `pipeline-analytics:media`. Three properties
 * were missing at once, and each one on its own was enough:
 *
 *  - it walked the whole collection in ONE offset space (`ORDER BY id`), so
 *    `track:` — the last prefix in id order, and where 23 594 orphaned rows
 *    and 9 714 MiB had accumulated — sat 300 000 rows behind a 20 000-row
 *    ceiling;
 *  - the cursor lived in RAM in a process that respawns several times a day,
 *    so every pass restarted at offset 0;
 *  - nothing reported the collection's SIZE, so `stoppedBy=row-ceiling
 *    nextCursor=20000` read as pacing for ten days.
 *
 * And the reclaim called `deleteByKey`, whose `deleteByKeyUnchecked` swallows
 * the unlink error and drops the row anyway — turning an orphan into bytes
 * nothing names, which is strictly worse than what it was cleaning up. The
 * store's own docblock says that is "NOT tolerable for a bulk reclaim".
 *
 * ## What it checks
 *
 * 1. **Every derived scope declares its SHARD.** A `scopes.push({ … })` in
 *    `orphan-audit.ts` without a `shard:` key is a scope walking an id space
 *    it does not name.
 * 2. **A scope can report how big it is.** `OrphanAuditDeps` must declare a
 *    `size` probe and `OrphanScopeReport` must carry `collectionSize` and
 *    `coveredWholeShard`. A pass with no denominator cannot claim coverage,
 *    and cannot warn about its absence.
 * 3. **A short pass WARNS.** The engine must warn when it did not cover its
 *    scope, and when a reclaim-mode pass freed no bytes against orphans it
 *    found. Both are the lines whose absence made a ten-day outage invisible.
 * 4. **The cursor is PERSISTED.** `runOrphanAuditPass` must both load and save
 *    through the cursor store. A resume position that only lives in a field is
 *    not a resume position.
 * 5. **The reclaim CONFIRMS its blob.** The audit pass must call
 *    `deleteConfirmed` and must not call `deleteByKey` / `deleteByKeyUnchecked`.
 *
 * ## The false-positive argument
 *
 * Every check is the presence or absence of a NAME in one of two files, both
 * named here explicitly. It makes no judgement about behaviour and fires on no
 * other sweep in the repo: another paged sweep is out of scope until it is
 * added to {@link SWEEP_FILES} deliberately. The complementary behavioural
 * assertions — that a walk really does reach past the old ceiling, and that a
 * failed unlink really does keep its row — live in
 * `retention/__tests__/sweep-covers-the-collection.spec.ts`, because a guard
 * over names cannot prove either.
 *
 * Usage: tsx scripts/check-sweep-coverage.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const ANALYTICS_ROOT = 'packages/addon-post-analysis/src/pipeline-analytics'
const ORPHAN_AUDIT_FILE = `${ANALYTICS_ROOT}/retention/orphan-audit.ts`
const ADDON_FILE = `${ANALYTICS_ROOT}/index.ts`

/** The files this guard is about, so widening it is deliberate. */
const SWEEP_FILES: readonly string[] = [ORPHAN_AUDIT_FILE, ADDON_FILE]

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

function read(relative: string): string | null {
  const full = path.join(ROOT, relative)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null
}

/** The body of the named method, from its signature to the next one-indent `}`. */
function methodBody(source: string, signature: string): string | null {
  const at = source.indexOf(signature)
  if (at < 0) return null
  const end = source.indexOf('\n  }\n', at)
  return end < 0 ? source.slice(at) : source.slice(at, end)
}

function checkEveryScopeDeclaresItsShard(source: string, problems: Problem[]): void {
  // Each derived scope is pushed as one object literal; the shard must be part
  // of it, because the cursor's MEANING is the pair (scope id, shard).
  const pushes = source.split('scopes.push({').slice(1)
  for (const [index, push] of pushes.entries()) {
    const literal = push.slice(0, push.indexOf('})'))
    if (!/\bshard\s*:/.test(literal)) {
      problems.push({
        where: ORPHAN_AUDIT_FILE,
        what: `scope #${index + 1} is pushed without a \`shard:\` — it walks an id space it does not name`,
        fix: 'give the scope a shard (`{ field, value }`) or `shard: null` for a whole-collection walk. One offset across a whole collection starved `track:` for the life of the audit.',
      })
    }
  }
  if (pushes.length === 0) {
    problems.push({
      where: ORPHAN_AUDIT_FILE,
      what: 'no derived scopes found — this guard can no longer see what the audit walks',
      fix: 'if scope derivation moved, point this guard at its new home rather than deleting the check.',
    })
  }
}

function checkCoverageIsReportable(source: string, problems: Problem[]): void {
  const required: readonly { readonly token: RegExp; readonly why: string }[] = [
    {
      token: /readonly size:\s*\(/,
      why: 'OrphanAuditDeps must declare a `size` probe — a pass with no denominator cannot claim, or question, its coverage',
    },
    {
      token: /readonly collectionSize:\s*number \| null/,
      why: 'OrphanScopeReport must carry `collectionSize: number | null` — and `null` for unmeasured, never 0 (D393)',
    },
    {
      token: /readonly coveredWholeShard:\s*boolean/,
      why: 'OrphanScopeReport must say whether the pass reached the end of its scope',
    },
    {
      token: /warn\('orphan audit: pass did not cover its scope/,
      why: 'a pass that walked part of its scope must WARN — `stoppedBy=row-ceiling` alone reads as pacing',
    },
    {
      token: /warn\('orphan audit: reclaim pass freed no bytes/,
      why: 'a reclaim pass that found orphans and freed no bytes must WARN — `bytesReclaimed=0` was logged at INFO for ten days against a 9.6 GiB backlog',
    },
  ]
  for (const { token, why } of required) {
    if (!token.test(source)) {
      problems.push({
        where: ORPHAN_AUDIT_FILE,
        what: `is missing ${token.source}`,
        fix: why,
      })
    }
  }
}

function checkCursorIsPersisted(source: string, problems: Problem[]): void {
  const body = methodBody(source, 'private async runOrphanAuditPass(')
  if (body === null) {
    problems.push({
      where: ADDON_FILE,
      what: 'runOrphanAuditPass not found — this guard can no longer see the audit wiring',
      fix: 'if the pass moved, point this guard at it rather than deleting the check.',
    })
    return
  }
  if (!/sweepCursors\?\.load\(\)/.test(body) || !/sweepCursors\?\.save\(/.test(body)) {
    problems.push({
      where: ADDON_FILE,
      what: 'the orphan audit pass does not both LOAD and SAVE its cursors',
      fix: 'a resume position that lives only in a field resets on every respawn — nine respawns in one day on the live hub, against a 6-hour sweep interval, meaning every pass re-walked the same 20 000 rows.',
    })
  }
  if (/deleteByKey(?:Unchecked)?\(/.test(body)) {
    problems.push({
      where: ADDON_FILE,
      what: 'the orphan audit pass reclaims through a best-effort delete (`deleteByKey`)',
      fix: '`deleteByKeyUnchecked` swallows the unlink error and drops the row anyway, converting an orphan into bytes nothing names. Use `deleteConfirmed`, whose own docblock says the best-effort path is "NOT tolerable for a bulk reclaim".',
    })
  }
  if (!/deleteConfirmed\(/.test(body)) {
    problems.push({
      where: ADDON_FILE,
      what: 'the orphan audit pass does not reclaim through `deleteConfirmed`',
      fix: 'the reclaim must unlink, re-probe and only then drop the row — and its confirmed count is what makes `bytesReclaimed` honest.',
    })
  }
}

function main(): void {
  const problems: Problem[] = []
  for (const file of SWEEP_FILES) {
    if (read(file) === null) {
      problems.push({
        where: file,
        what: 'does not exist',
        fix: 'this guard names the files it checks; update it in the same change that moves them.',
      })
    }
  }
  const audit = read(ORPHAN_AUDIT_FILE)
  const addon = read(ADDON_FILE)
  if (audit !== null) {
    checkEveryScopeDeclaresItsShard(audit, problems)
    checkCoverageIsReportable(audit, problems)
  }
  if (addon !== null) checkCursorIsPersisted(addon, problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} sweep-coverage violation(s)\x1b[0m:`)
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: the orphan audit ran for ten days in reclaim mode and never examined 96% of the media collection — 23 594 orphaned rows, 9 714 MiB — while logging `stoppedBy=row-ceiling orphans=0 bytesReclaimed=0` every time.',
    )
    process.exit(1)
  }
  console.log('  ✔ sweeps are sharded, sized, resumable from disk, and delete their bytes')
}

main()
