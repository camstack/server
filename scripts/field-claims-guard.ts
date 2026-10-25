/**
 * The judgement of `check-field-claims.ts` (D663), as a pure function over the
 * source files the script gathers — so each rule is proven red on a fixture.
 *
 * Two rules, each a closed allowlist of DEFINERS (ruling M: the guard passes
 * its own producers; before that it was red on them):
 *
 *  1. `claimFields` / `patchOwnedFields` / `releaseClaim` are called by the
 *     composer and defined by the cap, its generated routers and the
 *     device-manager's claim methods (`device-state-claims.ts`; the addon only
 *     spreads them and the index never names them). Anyone else naming them is a
 *     second writer of a field's authority (D62): a provider that claims its
 *     own field, an exporter that patches one.
 *  2. The row key `'$owned'` is spelled in `field-ownership.ts` alone. The
 *     mirror, the persist gate and the migration import `OWNED_FIELDS_KEY`; a
 *     consumer that spells the string has grown its own reading of the row.
 *
 * The judgement reads `code` (comments blanked by `walk-sources`): prose about
 * the contract is not a reference. Tests may name anything.
 */
import * as path from 'node:path'
import { type SourceFile, walkSources } from './lib/walk-sources.ts'

/** What the judgement reads of a file: its repo-relative path and its comment-free code. */
export type GuardFile = Pick<SourceFile, 'rel' | 'code'>

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** The real tree, as the CI step and the spec's last test read it. */
export function collectFieldClaimFiles(): readonly GuardFile[] {
  return walkSources(REPO_ROOT, ['packages', 'server', 'scripts'])
}

const CLAIM_METHOD = /\b(claimFields|patchOwnedFields|releaseClaim)\b/
const OWNED_KEY_LITERAL = /['"`]\$owned['"`]/

/** Exact paths and directory prefixes that DEFINE the claim contract. */
const CLAIM_METHOD_DEFINERS: readonly string[] = [
  'packages/types/src/capabilities/device-state.cap.ts',
  'packages/system/src/builtins/device-manager/device-state-claims.ts',
  'scripts/check-field-claims.ts',
  'scripts/field-claims-guard.ts',
]
const CLAIM_METHOD_DEFINER_DIRS: readonly string[] = ['packages/system/src/builtins/composer/']
/** The one module that spells the row key — and this guard, whose refusal message names it. */
const OWNED_KEY_DEFINERS: readonly string[] = [
  'packages/system/src/builtins/device-manager/field-ownership.ts',
  'scripts/field-claims-guard.ts',
]

function isTest(rel: string): boolean {
  return rel.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(rel)
}

/** Codegen output: any `generated/` directory, and a `generated-*.ts` file. */
function isGenerated(rel: string): boolean {
  return rel.includes('/generated/') || /(^|\/)generated-[^/]+\.ts$/.test(rel)
}

function mayNameClaimMethods(rel: string): boolean {
  return (
    isTest(rel) ||
    isGenerated(rel) ||
    CLAIM_METHOD_DEFINERS.includes(rel) ||
    CLAIM_METHOD_DEFINER_DIRS.some((dir) => rel.startsWith(dir))
  )
}

export function checkFieldClaimFacts(files: readonly GuardFile[]): readonly string[] {
  const failures: string[] = []
  for (const { rel, code } of files) {
    if (!mayNameClaimMethods(rel)) {
      const hit = CLAIM_METHOD.exec(code)
      if (hit) {
        failures.push(
          `${rel}: names ${hit[1]} — only the composer claims a field, and only the cap, ` +
            'its generated routers and the device-manager define the methods (D62, D663)',
        )
      }
    }
    if (!OWNED_KEY_DEFINERS.includes(rel) && !isTest(rel) && OWNED_KEY_LITERAL.test(code)) {
      failures.push(
        `${rel}: spells the row key '$owned' — import OWNED_FIELDS_KEY from field-ownership.ts; ` +
          'the row has one reading (D663)',
      )
    }
  }
  return failures
}
