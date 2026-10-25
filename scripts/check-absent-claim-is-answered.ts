#!/usr/bin/env tsx
/**
 * Absent-claim guard — an empty state may not be reached from a pending query.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * On 2026-08-31 an operator opened Recordings → Management and was told, in
 * plain words, that a component was **not installed**. It was installed and
 * running the whole time; the query behind the gate had simply not answered
 * yet. The code was one line:
 *
 *     const available = (topology ?? []).some((n) => n.addons.some(…))
 *
 * `??` turns "no answer yet" into "the empty answer", and `.some` over the
 * empty answer is `false`, and `false` renders "not installed". Nothing in the
 * type system objects, because a `boolean` has room for exactly two of the
 * three things this gate has to say. The missing one is the one the operator
 * sees FIRST.
 *
 * D62 states the rule for a switch — *disabled must never look like broken*.
 * One step earlier the same rule holds: **not-yet-known must never look like
 * not-installed.** An operator who reads "not installed" concludes their addon
 * has crashed and goes hunting a fault that does not exist. A UI that is
 * merely slow costs seconds; a UI that is confidently wrong costs an
 * investigation.
 *
 * ── What is checked ───────────────────────────────────────────────────────
 *  1. **The absent-claim vocabulary is reserved.** A UI source that tells the
 *     operator something is *not installed* / *not deployed* / that the system
 *     *doesn't advertise* a capability must derive that from a resolved
 *     presence (`lib/capability-presence`), which cannot be constructed from
 *     an unanswered query. Anything else needs an entry in
 *     `ALLOWED_ABSENT_CLAIMS` with a reason — the point is that the claim is a
 *     deliberate, reviewed act rather than a fallback somebody fell into.
 *
 *  2. **An availability hook may not answer with a `boolean`.** `function
 *     useXAvailable(): boolean` is the shape that caused this, and it causes
 *     it again every time: two values cannot carry a three-valued fact. Return
 *     a discriminated union whose `pending` member a caller has to render.
 *
 *  3. **A caller of `useCapabilityPresence` must handle `'pending'`.** The
 *     honest hook is trivially re-collapsed —
 *     `presence === 'present' ? <Panel/> : <NotInstalled/>` puts the lie back
 *     with the tri-state still in the file. A file that asks the question owns
 *     the answer it does not like.
 *
 * SCOPE: UI trees only — a `.tsx` file, or a `.ts` file that imports React or
 * `@camstack/ui-library`, under `packages/addon-<name>/src` or
 * `packages/ui-library/src`. An addon's BACKEND half says "not installed" about
 * plenty of things (a missing python runtime, a codec, an intercom peer) with
 * no query and no operator on the other end; those are a different sentence.
 * Tests are excluded — a spec asserting the absent copy is the guard working.
 *
 * Comments are stripped before matching: prose ABOUT the rule, including this
 * file's own siblings, is not a violation.
 *
 * Usage: tsx scripts/check-absent-claim-is-answered.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGES = path.join(ROOT, 'packages')

/** The module that owns the tri-state answer. */
const PRESENCE_MODULE = 'capability-presence'
const PRESENCE_HOOK = 'useCapabilityPresence'

/**
 * Phrases that tell an operator a component is ABSENT. Deliberately narrow:
 * "unavailable", "not configured" and "no data yet" describe states a resolved
 * query legitimately reports, and widening this list to them would turn the
 * guard into an allowlist-maintenance chore that nobody reads.
 */
const ABSENT_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bnot\s+installed\b/i,
  /\bisn['’]t\s+installed\b/i,
  /\bnot\s+deployed\b/i,
  /\b(?:does\s+not|doesn['’]t)\s+advertise\b/i,
]

/**
 * Files allowed to make an absent claim without a resolved capability
 * presence. Each needs a reason that says why the claim cannot be premature.
 */
const ALLOWED_ABSENT_CLAIMS: ReadonlyMap<string, string> = new Map([
  [
    'packages/addon-admin-ui/src/components/users/TotpQrCode.tsx',
    'The claim is about a BROWSER BUNDLE (`import("qrcode")` rejected), not a cluster ' +
      'capability. There is no query to be pending on: the dynamic import has already ' +
      'settled by the time the message is set, and the component renders a spinner until ' +
      'it does.',
  ],
  [
    'packages/ui-library/src/composites/device-picker/device-selection-rows.tsx',
    'The claim is about a selected PACKAGE NAME the answered package list lacks, not a ' +
      'capability. It renders only for a row whose `removed` is true, and ' +
      '`resolveSelectedDevices` (`device-selection.ts`) sets `removed` only when the list ' +
      "state is `'answered'` — a pending or failed list yields `removed: false` for every " +
      'id, so the row reads as the bare id instead (D315, D637).',
  ],
])

/**
 * Hook names that answer a presence question. A `boolean` return on one of
 * these is the defect, stated in the signature.
 */
const AVAILABILITY_HOOK = /\buse[A-Z][A-Za-z0-9]*(?:Available|Installed|Present|Supported)\b/

// ── File collection ────────────────────────────────────────────────────────

function isUiPackage(dir: string): boolean {
  return dir === 'ui-library' || dir.startsWith('addon-')
}

function collectUiSources(): readonly string[] {
  const out: string[] = []
  for (const pkg of fs.readdirSync(PACKAGES)) {
    if (!isUiPackage(pkg)) continue
    const src = path.join(PACKAGES, pkg, 'src')
    if (!fs.existsSync(src)) continue
    walk(src, out)
  }
  return out
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }
      walk(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(spec|test)\.tsx?$/.test(entry.name)) continue
    if (isUiSource(full)) out.push(full)
  }
}

/**
 * A file that renders, or feeds something that renders. `.tsx` is unambiguous;
 * a `.ts` counts when it reaches for React or the shared UI library, which is
 * what a gate hook does (`lib/capability-presence.ts` is one).
 */
function isUiSource(full: string): boolean {
  if (full.endsWith('.tsx')) return true
  const source = fs.readFileSync(full, 'utf8')
  return /from ['"]react['"]|from ['"]@camstack\/ui-library['"]/.test(source)
}

/**
 * Drop `//` and block comments so documentation of the rule — including a
 * quoted example of the wrong copy — never trips it. Naive on purpose: a `//`
 * inside a string literal costs at most a missed detection, never a false one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ── Rules ──────────────────────────────────────────────────────────────────

interface Violation {
  readonly file: string
  readonly rule: string
  readonly detail: string
}

function checkAbsentClaimVocabulary(rel: string, code: string): Violation | null {
  const matched = ABSENT_CLAIM_PATTERNS.find((pattern) => pattern.test(code))
  if (!matched) return null
  if (ALLOWED_ABSENT_CLAIMS.has(rel)) return null
  if (code.includes(PRESENCE_MODULE) || code.includes(PRESENCE_HOOK)) return null
  return {
    file: rel,
    rule: 'absent-claim-needs-a-resolved-presence',
    detail:
      `tells the operator something is absent (matched ${String(matched)}) without ` +
      `resolving it through \`${PRESENCE_HOOK}\`. A gate built on \`data ?? []\` renders ` +
      `this copy while the query is still in flight. Use the tri-state, or add this file ` +
      `to ALLOWED_ABSENT_CLAIMS with a reason the claim cannot be premature.`,
  }
}

function checkBooleanAvailabilityHook(rel: string, code: string): Violation | null {
  // `function useXAvailable(...): boolean` and `const useXAvailable = (...): boolean =>`
  const declarations = code.matchAll(
    /(?:function\s+(use[A-Z][A-Za-z0-9]*)\s*\([^)]*\)\s*:\s*boolean|const\s+(use[A-Z][A-Za-z0-9]*)\s*(?::[^=]*)?=\s*\([^)]*\)\s*:\s*boolean)/g,
  )
  for (const match of declarations) {
    const name = match[1] ?? match[2] ?? ''
    if (!AVAILABILITY_HOOK.test(name)) continue
    return {
      file: rel,
      rule: 'availability-hook-is-not-a-boolean',
      detail:
        `\`${name}(): boolean\` cannot express "not answered yet", so every caller that ` +
        `renders its \`false\` branch asserts absence during loading. Return a ` +
        `discriminated presence instead (see lib/capability-presence).`,
    }
  }
  return null
}

/**
 * A barrel that RE-EXPORTS the hook is not a caller.
 *
 * `export { useCapabilityPresence } from './hooks/use-capability-presence'`
 * mentions the name and renders nothing, so demanding `'pending'` of it would
 * force a comment shaped like a state machine into an index file. Only a call
 * site can re-collapse the tri-state, so re-export statements are removed
 * before the mention is counted.
 */
function withoutReExports(code: string): string {
  return code.replace(/export\s*(?:type\s*)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, '')
}

function checkPendingIsHandled(rel: string, code: string): Violation | null {
  if (!withoutReExports(code).includes(PRESENCE_HOOK)) return null
  // The hook's own module, wherever it lives: `lib/capability-presence.ts`
  // (the admin-UI re-export kept for its callers) and
  // `hooks/use-capability-presence.ts` (the ui-library implementation the
  // framework-mounted widgets reach).
  if (rel.endsWith(`lib/${PRESENCE_MODULE}.ts`)) return null
  if (rel.endsWith(`hooks/use-${PRESENCE_MODULE}.ts`)) return null
  if (/['"]pending['"]/.test(code)) return null
  return {
    file: rel,
    rule: 'presence-caller-must-render-pending',
    detail:
      `calls \`${PRESENCE_HOOK}\` but never mentions \`'pending'\`. Comparing only against ` +
      `\`'present'\` re-collapses the tri-state and puts the premature absent claim back.`,
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const violations: Violation[] = []
for (const file of collectUiSources()) {
  const rel = path.relative(ROOT, file)
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  for (const check of [
    checkAbsentClaimVocabulary,
    checkBooleanAvailabilityHook,
    checkPendingIsHandled,
  ]) {
    const violation = check(rel, code)
    if (violation) violations.push(violation)
  }
}

// A stale allowlist entry is a rule nobody is enforcing — fail on it too.
for (const [rel, reason] of ALLOWED_ABSENT_CLAIMS) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    violations.push({
      file: rel,
      rule: 'stale-allowlist-entry',
      detail: `ALLOWED_ABSENT_CLAIMS names a file that no longer exists (reason: ${reason})`,
    })
    continue
  }
  if (
    !ABSENT_CLAIM_PATTERNS.some((pattern) =>
      pattern.test(stripComments(fs.readFileSync(full, 'utf8'))),
    )
  ) {
    violations.push({
      file: rel,
      rule: 'stale-allowlist-entry',
      detail: 'ALLOWED_ABSENT_CLAIMS entry no longer makes an absent claim — remove it',
    })
  }
}

if (violations.length > 0) {
  console.error('✗ absent-claim guard: an empty state may not be reached from a pending query\n')
  for (const violation of violations) {
    console.error(`  ${violation.file}`)
    console.error(`    [${violation.rule}] ${violation.detail}\n`)
  }
  process.exit(1)
}

console.log('✓ absent-claim guard: every absent claim is reached from an answered query')
