#!/usr/bin/env tsx
/**
 * Viewer ship-chain guard — refuses a `camstack` submodule pointer that is not
 * a viewer commit.
 *
 * ## The failure this catches
 *
 * The last step of the viewer ship chain records the submodule pointer by hand:
 *
 * ```
 * git update-index --cacheinfo 160000,<sha>,camstack
 * ```
 *
 * Nothing checks the `<sha>`. On 2026-09-08 the pointers shipped with 1.0.465,
 * 1.0.466 and 1.0.467 were each a SERVER commit — the release commit that was
 * HEAD at the time, pasted where the viewer sha belonged. Every one of the
 * three looked perfect in `git log`; `git ls-tree HEAD camstack` returned a
 * plausible 40-hex string, the release message named the right version, and the
 * hub was serving the right bundle. The repository still could not produce that
 * viewer: `git submodule update --init camstack` on a fresh clone fails to find
 * the object, because it does not exist in the viewer repository at all.
 *
 * That is the specific hazard of `--cacheinfo`: it writes whatever sha it is
 * given, into a tree entry git does not resolve until someone clones. The
 * mistake is silent for as long as everyone has a working checkout.
 *
 * ## What it checks
 *
 * Only the thing that was wrong: the pinned object EXISTS in the submodule, and
 * is a commit. Deliberately NOT checked:
 *
 *  - that it matches `.viewer-version` — `check-viewer-web-build.ts` already
 *    owns the version comparison, and two guards disagreeing about one fact is
 *    worse than one;
 *  - that it is on `main`, or pushed. A pin to a local commit is a real
 *    workflow (a bisect, a fix under test), and failing on it would train the
 *    chain's operator to skip the guard — which is how a guard stops being one.
 *
 * ## It must not need the submodule — CI does not check one out
 *
 * Written first as "resolve the sha in `camstack/`", which SKIPPED in CI on
 * every run: this workflow clones without submodules, so the guard would have
 * described the right rule and enforced nothing. A guard that cannot fire is
 * worse than no guard, because the checklist says it is covered.
 *
 * So there are two checks, and the weaker one always runs:
 *
 *  - submodule present → resolve the object there. The full statement.
 *  - submodule absent → assert the sha is NOT a commit in THIS repository.
 *    That is the exact signature of the defect (a server sha pasted into
 *    `--cacheinfo`), it needs nothing but the clone CI already has, and a sha
 *    cannot be a commit in both repositories by accident.
 *
 * The weak check cannot prove a pin good — a typo'd sha belonging to nothing
 * passes it — and it says so rather than printing a tick that overstates what
 * was verified.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUBMODULE = path.join(ROOT, 'camstack')

/** The sha the tree records for `camstack`, or null when there is no gitlink. */
export function pinnedSha(lsTreeLine: string): string | null {
  // `160000 commit <sha>\tcamstack`
  const match = /^160000 commit ([0-9a-f]{40})\t/.exec(lsTreeLine.trim())
  return match?.[1] ?? null
}

/** The object's type in the repository at `cwd`, or null when it has no such object. */
function objectTypeIn(cwd: string, sha: string): string | null {
  try {
    return execFileSync('git', ['cat-file', '-t', sha], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function isCommitIn(cwd: string, sha: string): boolean {
  return objectTypeIn(cwd, sha) === 'commit'
}

function fail(message: string): never {
  console.error(`✘ viewer pin: ${message}`)
  process.exit(1)
}

function main(): void {
  // `VIEWER_PIN_REF` exists so this guard can be pointed at a commit other than
  // HEAD — that is how it was proven red, against the three 2026-09-08 releases
  // that carried a server sha. CI leaves it unset.
  const ref = process.env['VIEWER_PIN_REF'] ?? 'HEAD'
  const line = execFileSync('git', ['ls-tree', ref, 'camstack'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const sha = pinnedSha(line)
  if (sha === null) {
    console.log('  ⊘ no camstack gitlink in HEAD — nothing to resolve')
    return
  }
  if (!fs.existsSync(path.join(SUBMODULE, '.git'))) {
    // No submodule to resolve against — check the one thing this clone CAN
    // answer: is the pinned sha a commit in the SERVER repository? That is what
    // every one of the three broken pins was.
    if (isCommitIn(ROOT, sha)) {
      fail(
        `${ref} pins camstack at ${sha}, which is a commit in THIS repository — ` +
          `a server sha pasted into \`git update-index --cacheinfo 160000,<sha>,camstack\`. ` +
          `Take the sha from \`git -C camstack rev-parse HEAD\`.`,
      )
    }
    console.log(
      `  ~ viewer pin ${sha.slice(0, 9)} is not a server commit (the camstack/ submodule is ` +
        `not checked out here, so it could not be resolved in the viewer repository)`,
    )
    return
  }
  const type = objectTypeIn(SUBMODULE, sha)
  if (type === null) {
    fail(
      `${ref} pins camstack at ${sha}, which does not exist in the viewer repository. ` +
        `A fresh clone cannot check this submodule out. This is what pasting a SERVER sha ` +
        `into \`git update-index --cacheinfo 160000,<sha>,camstack\` looks like — take the sha ` +
        `from \`git -C camstack rev-parse HEAD\`, never from the server repo's log.`,
    )
  }
  if (type !== 'commit') fail(`${ref} pins camstack at ${sha}, which is a ${type}, not a commit.`)
  console.log(`  ✔ viewer pin ${sha.slice(0, 9)} resolves in the camstack submodule`)
}

main()
