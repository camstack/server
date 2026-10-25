#!/usr/bin/env tsx
/**
 * Pinned-`addonId` refusal guard — an unresolvable collection pin must never
 * degrade into another provider's answer.
 *
 * ## The failure this catches
 *
 * A `scope:'system', mode:'collection'` cap routes a single-provider call via
 * the out-of-band `{ addonId }` selector. `getProviderByAddonId` returns `null`
 * for an id nobody owns — and `null` is ALSO what the hub root returns when a
 * cap legitimately lives in a forked hub worker. The router could not tell the
 * two apart, so it fell through to `remoteProxy(cap, 'hub')`, whose Moleculer
 * prefix lookup answered from the FIRST hub-side provider. Measured live on
 * 2026-08-09:
 *
 *   deviceExport.getStatus { addonId: 'export-alexa' }         → linked   | 3
 *   deviceExport.getStatus { addonId: 'homeassistant-export' } → unlinked | 0
 *   deviceExport.getStatus { addonId: 'questo-non-esiste' }    → linked   | 3
 *
 * The third line is a fabricated id receiving Alexa's status, with no error.
 * The Home Assistant component pins `homeassistant-export` precisely so it does
 * NOT get the merged aggregate; one missing/renamed/undeployed addon and it
 * would have silently imported Alexa's devices while looking like success. All
 * 24 collection caps shared the one resolver, so all 24 shared the hole.
 *
 * A wrong identifier that produces a plausible answer instead of an error is a
 * recurring shape in this repo (`camstack deploy` accepting fake node ids). It
 * gets a check.
 *
 * ## What it checks
 *
 * 1. `CapRouterServices` DECLARES `rejectUnresolvedAddonPin`.
 * 2. `resolveProviderForCall` CALLS it, and does so BEFORE the
 *    `remoteProxy(capName, 'hub')` fallthrough — after it would be decoration.
 * 3. Both collection call sites pass the explicit pin into
 *    `resolveProviderForCall` (a call site that forgets the argument silently
 *    restores the old behaviour for that branch only).
 * 4. The server IMPLEMENTS it in the object returned by
 *    `createCapRouterServices`, and that implementation both `throw`s and logs
 *    — AGENTS.md: a branch that drops work silently logs it.
 *
 * Every check is the presence of a declaration, a call, or an argument: syntax
 * that is either there or not, never a judgement call.
 *
 * Usage: tsx scripts/check-addon-pin-refusal.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const BUILDER = 'packages/system/src/kernel/cap-router-builder.ts'
const RUNTIME = 'server/backend/src/api/trpc/cap-router-runtime.ts'
const HOOK = 'rejectUnresolvedAddonPin'

const errors: string[] = []

function read(rel: string): string {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    errors.push(`${rel}: file not found — the guard's anchor moved; update this check.`)
    return ''
  }
  return fs.readFileSync(abs, 'utf8')
}

/** Extract a function body by name, brace-matched from its opening `{`. */
function functionBody(source: string, name: string): string | null {
  const at = source.indexOf(`function ${name}(`)
  if (at === -1) return null
  const open = source.indexOf('{', at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

const builder = read(BUILDER)
const runtime = read(RUNTIME)

// ── 1. The contract exists on CapRouterServices ────────────────────────────
if (!/readonly\s+rejectUnresolvedAddonPin\?:/.test(builder)) {
  errors.push(
    `${BUILDER}: CapRouterServices no longer declares \`${HOOK}\`. Without it an ` +
      `unresolvable { addonId } pin falls through to the hub proxy and is answered by ` +
      `another provider.`,
  )
}

// ── 2. It is called, before the hub-proxy fallthrough ──────────────────────
const body = functionBody(builder, 'resolveProviderForCall')
if (body === null) {
  errors.push(`${BUILDER}: \`resolveProviderForCall\` not found — update this guard.`)
} else {
  const callAt = body.indexOf(`services.${HOOK}?.(`)
  const fallthroughAt = body.indexOf(`services.remoteProxy(capName, 'hub')`)
  if (callAt === -1) {
    errors.push(
      `${BUILDER}: \`resolveProviderForCall\` does not call \`services.${HOOK}?.()\`. ` +
        `A pinned addonId that resolves to nothing must REFUSE, not fall through.`,
    )
  } else if (fallthroughAt === -1) {
    errors.push(
      `${BUILDER}: the \`remoteProxy(capName, 'hub')\` fallthrough moved — update this guard ` +
        `so it can still prove the refusal happens first.`,
    )
  } else if (callAt > fallthroughAt) {
    errors.push(
      `${BUILDER}: \`${HOOK}\` is called AFTER the hub-proxy fallthrough. The proxy already ` +
        `answered by then; the refusal must come first.`,
    )
  }
}

// ── 3. Both collection call sites forward the explicit pin ─────────────────
// `resolveProviderForCall(capName, <nodeId>, () => getLocal(...), services, <pin>)`
// — the 5th argument is the pin. A call site that stops passing it re-opens
// the hole for its own branch only, which is exactly the silent kind.
const callSites = [...builder.matchAll(/resolveProviderForCall\(\s*\n?/g)].length
// The object-input branch forwards `refusePin`, which starts as the explicit
// `topLevelAddonId` and is only ever WIDENED to a cap-inferred owner (D886) —
// never to a nested-payload heuristic. Accept it only when it is seeded so.
const refusePinSeededFromTopLevel = /let refusePin = topLevelAddonId\b/.test(builder)
const pinnedSites =
  [...builder.matchAll(/services,\s*\n\s*isCollection \? sel\.addonId : undefined,/g)].length +
  [...builder.matchAll(/services,\s*\n\s*topLevelAddonId,/g)].length +
  (refusePinSeededFromTopLevel ? [...builder.matchAll(/services,\s*\n\s*refusePin,/g)].length : 0)
if (pinnedSites < 2) {
  errors.push(
    `${BUILDER}: expected both COLLECTION call sites of \`resolveProviderForCall\` to pass the ` +
      `explicit pin (the void-input \`sel.addonId\` branch and the object-input ` +
      `\`topLevelAddonId\` branch); found ${pinnedSites} of 2 across ${callSites} call site(s).`,
  )
}

// ── 4. The server implements it: wired, refusing, and logging ──────────────
if (!new RegExp(`const ${HOOK}\\s*:`).test(runtime)) {
  errors.push(`${RUNTIME}: no \`${HOOK}\` implementation — the builder's hook is unwired.`)
}
if (!new RegExp(`\\n\\s*${HOOK},`).test(runtime)) {
  errors.push(
    `${RUNTIME}: \`${HOOK}\` is not returned in the CapRouterServices object. Defining it ` +
      `without handing it to the builder leaves the fallthrough live while reading as fixed.`,
  )
}
const implAt = runtime.indexOf(`const ${HOOK}`)
if (implAt !== -1) {
  const impl = runtime.slice(implAt, implAt + 2000)
  if (!/throw new TRPCError/.test(impl)) {
    errors.push(
      `${RUNTIME}: \`${HOOK}\` does not throw. Returning quietly restores the exact defect: ` +
        `the caller gets another provider's answer.`,
    )
  }
  if (!/logger\?\.warn\(/.test(impl)) {
    errors.push(
      `${RUNTIME}: \`${HOOK}\` does not log the refusal. AGENTS.md: a branch that drops work ` +
        `silently logs it — a refused pin that produces no line cannot be diagnosed.`,
    )
  }
}

if (errors.length > 0) {
  console.error('✗ pinned-addonId refusal guard failed:\n')
  for (const e of errors) console.error(`  • ${e}\n`)
  process.exit(1)
}
console.log('✓ pinned-addonId refusal guard: an unresolvable { addonId } pin refuses and logs')
