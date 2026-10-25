/**
 * The `git diff` core of `codegen.ts --check`: after regenerating every
 * derived artifact, fail if any of them differs from what's committed
 * (working tree vs the git index).
 *
 * Extracted so this logic has a fast local test independent of any CI
 * workflow. Why that independence matters, concretely: `faceGallery.listIdentities`
 * / `plateGallery.listVehicles` gained a real `includeCrops` input in
 * (2026-08-25 20:45) and `generated-cap-routers.ts` was not
 * regenerated to match until (2026-08-25 22:12) — 1.5h where the
 * committed router still declared the old `{ nodeId?: string }` shape and
 * called the provider with no arguments. `codegen:check` has been wired into
 * `ci.yml` since (2026-07-24), so on paper every commit in that
 * window should have been checked, and CI never reported red.
 *
 * The reason has nothing to do with this function: reproducing the stale
 * commit (staging the pre- router shape, then running
 * `npm run codegen:check` exactly as CI does) fails immediately and prints
 * exactly the `includeCrops` diff — this diff logic was never broken. The CI
 * workflow itself (`.github/workflows/ci.yml`, "CI") was `disabled_manually`
 * in GitHub from 2026-08-21 ~10:29 CEST (~20 minutes after an unrelated
 * "docs are in sync" failure) through at least 2026-08-26 — a window that
 * fully contains the → staleness. No run means no
 * check executed, on this commit or any other; "CI was green" reads as
 * "nothing caught it" but the accurate read is "nothing ran". See
 * `docs/design/plans/phase-7-topics-lost-between-hops.md` Task 7.2 and the
 * dormancy comment at the top of `ci.yml` — this is the same failure mode
 * recurring, exactly as that comment warned it could.
 *
 * This module doesn't fix workflow-enablement (that's a GitHub setting, not
 * code) — it fixes the fact that the check's own drift-detection logic had
 * zero test coverage of its own and was verified only by trusting a CI run.
 * Every sibling guard in `scripts/` that does real comparison work
 * (`framework-dist-freshness.ts`, `capability-metadata-drift.ts`) is a pure,
 * separately-tested module; this one wasn't.
 */
import { spawn } from 'node:child_process'

export interface GeneratedDriftResult {
  readonly ok: boolean
  readonly diff: string
}

/**
 * Fail if any path in `paths` (relative to `cwd`) differs between the
 * working tree and the git index. `codegen.ts --check` calls this AFTER
 * regenerating every artifact, so a non-empty diff means a generated file on
 * disk (freshly regenerated) disagrees with what's committed — i.e. drift.
 */
export function checkGeneratedDrift(
  cwd: string,
  paths: readonly string[],
): Promise<GeneratedDriftResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['diff', '--exit-code', '--', ...paths], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diff = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      diff += chunk.toString('utf8')
    })
    child.stderr?.on('data', () => undefined)
    child.on('close', (code) => resolve({ ok: code === 0, diff }))
  })
}
