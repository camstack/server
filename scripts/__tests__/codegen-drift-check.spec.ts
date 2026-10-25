/**
 * `checkGeneratedDrift` is the `git diff` core of `codegen.ts --check` — see
 * `../codegen-drift-check.ts` for why it was extracted: the 2026-08-25
 * `includeCrops` staleness (`generated-cap-routers.ts` still declaring the
 * pre-input `faceGallery.listIdentities` / `plateGallery.listVehicles` shape
 * for 1.5h) shipped past a CI check that had been wired in long before,
 * and it was tempting to assume the diff logic itself had a
 * bug. It didn't: reproducing the stale commit and running
 * `npm run codegen:check` exactly as CI does fails immediately with exactly
 * this diff. The second test below is that reproduction, pinned as a
 * regression test that doesn't depend on a CI workflow being enabled to run
 * it. (The actual cause was the `ci.yml` "CI" workflow having been
 * `disabled_manually` in GitHub since 2026-08-21 — nothing ran, not "ran and
 * passed". See Task 7.2 in
 * `docs/design/plans/phase-7-topics-lost-between-hops.md`.)
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkGeneratedDrift } from '../codegen-drift-check.ts'

describe('checkGeneratedDrift', () => {
  let repo: string

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-drift-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  function commitFile(relPath: string, content: string): void {
    const full = path.join(repo, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    execFileSync('git', ['add', relPath], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo })
  }

  it('passes when a regenerated file matches what is committed', async () => {
    commitFile('generated/router.ts', 'export const x = 1\n')
    const result = await checkGeneratedDrift(repo, ['generated/router.ts'])
    expect(result.ok).toBe(true)
    expect(result.diff).toBe('')
  })

  it('fails on the real 2026-08-25 shape: cap gained an input, committed router still calls with none', async () => {
    // The committed shape, matching generated-cap-routers.ts before 20d678aad:
    // `listIdentities` still declared `{ nodeId?: string }` and called the
    // provider with zero arguments even though the cap had already gained a
    // real `includeCrops` input.
    commitFile(
      'generated/router.ts',
      [
        'listIdentities: protectedProcedure',
        '  .input(z.object({ nodeId: z.string().optional() }).optional())',
        '  .query(async ({ input, ctx }) => {',
        '    const p = resolveProvider(',
        "      'face-gallery',",
        '      input?.nodeId,',
        '      () => getProvider(ctx),',
        '      createRemoteProxy,',
        '    )',
        '    return p.listIdentities()',
        '  }),',
        '',
      ].join('\n'),
    )

    // codegen.ts's regeneration step overwrites the working tree with fresh
    // output BEFORE the drift check runs — simulate exactly that: the cap
    // now has a real input, so the regenerated router passes it through.
    fs.writeFileSync(
      path.join(repo, 'generated/router.ts'),
      [
        'listIdentities: protectedProcedure',
        '  .input(faceGalleryCapability.methods.listIdentities.input)',
        '  .query(async ({ input, ctx }) => {',
        "    const p = requireCapProvider('face-gallery', () => getProvider(ctx))",
        '    return p.listIdentities(input)',
        '  }),',
        '',
      ].join('\n'),
    )

    const result = await checkGeneratedDrift(repo, ['generated/router.ts'])
    expect(result.ok).toBe(false)
    expect(result.diff).toContain('-    return p.listIdentities()')
    expect(result.diff).toContain('+    return p.listIdentities(input)')
  })

  it('is blind to a stale file outside the watched path set — scope is exactly what is passed in', async () => {
    commitFile('unwatched/file.ts', 'export const a = 1\n')
    fs.writeFileSync(path.join(repo, 'unwatched/file.ts'), 'export const a = 2\n')

    const result = await checkGeneratedDrift(repo, ['generated/router.ts'])
    expect(result.ok).toBe(true)
  })
})
