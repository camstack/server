/**
 * The judgement of `check-claimed-get-status.ts` (D663, ruling S3), as a pure
 * function over the source files the script gathers — so the rule is proven red
 * on a fixture.
 *
 * ONE rule. A production file that resolves a cap call BY NAME — it calls
 * `resolveCapRoute(`, `resolveChildId(` or `callCapOnChild(` — dispatches
 * straight to the owning runner, whose `getStatus` is the NATIVE slice of a
 * claimed cap. So every such file must first ask the hub's claim authority
 * through the one shared function, `answerClaimedGetStatus(`. Task 7 shipped the
 * hook on one entry and missed the two that carried the live traffic; this guard
 * is what makes a fourth entry impossible to add quietly.
 *
 * The exceptions are DOWNSTREAM of an entry that already asked, or not a cap
 * call at all, and each is named with its reason. The judgement reads `code`
 * (comments blanked by `walk-sources`): prose about the contract is not a call.
 * Tests and codegen output may name anything.
 *
 * What this tripwire cannot see — read before trusting it further:
 *   - It is FILE-granular. A new method inside a file that already asks
 *     (`local-child-registry.ts`, `parent-unowned-call.ts`,
 *     `moleculer.service.ts`) can resolve by name without asking and pass;
 *     today every such site in those files is downstream of the hook (the
 *     handler's retry loop, `callCap`, `createCapabilityProxy`'s reachability
 *     probe), verified by reading, not by this script.
 *   - It matches the NAME (`resolveCapRoute`, `resolveChildId`, `callCapOnChild`,
 *     `callCap`) as a word, so a destructured or bracket access counts — and so
 *     does a type-only mention, which is why the resolver's own interfaces are
 *     exceptions.
 */
import * as path from 'node:path'
import { type SourceFile, walkSources } from './lib/walk-sources.ts'

/** What the judgement reads of a file: its repo-relative path and its comment-free code. */
export type GuardFile = Pick<SourceFile, 'rel' | 'code'>

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** The real tree, as the CI step and the spec's last test read it. */
export function collectClaimedGetStatusFiles(): readonly GuardFile[] {
  return walkSources(REPO_ROOT, ['packages', 'server'])
}

/**
 * A resolution of a cap by NAME to the runner that will answer it — as a
 * method call, a destructured binding or a bracket access alike.
 */
const NAME_RESOLUTION = /\b(resolveCapRoute|resolveChildId|callCapOnChild|callCap)\b/
const ASKS_CLAIM_AUTHORITY = /\banswerClaimedGetStatus\(/

/**
 * Files that resolve by name WITHOUT asking, each with the reason it may.
 * A new entry does not belong here unless it is provably downstream of one that
 * asked — the point of the guard is that the list is read, not grown.
 */
export const NAME_RESOLUTION_EXCEPTIONS: Readonly<Record<string, string>> = {
  'packages/system/src/kernel/transport/cap-route-resolver.ts':
    'the resolver itself: classifies and dispatches a route an ENTRY already asked about',
  'server/backend/src/core/moleculer/cap-call-fn.ts':
    'a manifest callFn reached only through callCapabilityOnNode, which asks first',
  'server/backend/src/core/addon/addon-call-gateway.ts':
    'the addon-call plane (callAddonOnChild), not a cap call',
  'server/backend/src/agent/agent-cap-dispatch-service.ts':
    'the AGENT side of a hub-forwarded call: the hub asked before forwarding (the agent-local gap is D663’s open item)',
  'server/backend/src/core/addon/addon-registry.service.ts':
    'hands the addon-call gateway its addonId→childId resolver (the addon-call plane, not a cap call); its nativeFallback builds the native OBJECT the registry’s D13 overlay wraps',
}

function isTest(rel: string): boolean {
  return rel.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(rel)
}

/** Codegen output: any `generated/` directory, and a `generated-*.ts` file. */
function isGenerated(rel: string): boolean {
  return rel.includes('/generated/') || /(^|\/)generated-[^/]+\.ts$/.test(rel)
}

/** Every failure is one line naming the file and what it must do. */
export function checkClaimedGetStatusFacts(files: readonly GuardFile[]): readonly string[] {
  const failures: string[] = []
  for (const f of files) {
    if (isTest(f.rel) || isGenerated(f.rel)) continue
    if (!NAME_RESOLUTION.test(f.code)) continue
    if (ASKS_CLAIM_AUTHORITY.test(f.code)) continue
    if (f.rel in NAME_RESOLUTION_EXCEPTIONS) continue
    failures.push(
      `${f.rel}: resolves a cap call by name (resolveCapRoute / resolveChildId / callCapOnChild / callCap) without asking the claim authority — call answerClaimedGetStatus() before routing a device-scoped getStatus (D663, S3), or name it in NAME_RESOLUTION_EXCEPTIONS with the reason it is downstream of an entry that did`,
    )
  }
  return failures
}
