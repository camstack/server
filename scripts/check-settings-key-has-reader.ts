#!/usr/bin/env tsx
/**
 * Settings-key guard — a form must not offer a knob that writes a store NOBODY
 * READS.
 *
 * ## What it replaces, and why an allow-list was not enough
 *
 * `packages/addon-post-analysis/src/pipeline-analytics/__tests__/settings-schema-dead-knobs.spec.ts`
 * pinned exactly two removed names, `trackTtlMs` and `maxPositionHistory`. It
 * was an allow-list of two strings, not a reachability check — so
 * `mediaAttachPolicy` sat DEAD in the very same file the spec guarded, and the
 * 2026-08-28 cluster-settings census
 * (`docs/design/2026-08-28-cluster-settings-census.md` §4) found nine such
 * knobs across five addons. Every one of them was locally reasonable in the
 * file it was written in. That is what makes this a guard rather than a
 * paragraph (D272).
 *
 * ## The rule
 *
 * For every settings field declared in an addon's UI schema, the field's `key`
 * must appear SOMEWHERE in the workspace in a shape that is not a declaration.
 *
 * "Declaration-shaped" is a closed list:
 *
 *  - `key: 'name'`                   — the field declaration itself
 *  - `name: <anything>`              — an object-literal property, an interface
 *                                      member, a Zod schema field, a defaults
 *                                      entry (`readonly name: T`, `name: 5`)
 *
 * Anything else — `this.config.name`, `merged.name`, `store['name']`,
 * `pick('name')`, `resolved.name` — is a READ, and the key passes.
 *
 * A key whose ONLY appearances are declaration-shaped is declared, defaulted,
 * typed, written on Save, and consumed by nothing. That is exactly the shape of
 * `maxDecodeFps`, `initialReconnectDelayMs`, `maxReconnectDelayMs` and
 * `mediaAttachPolicy`, all deleted on 2026-08-28.
 *
 * ## What this guard CANNOT catch — stated plainly, because it matters
 *
 * Reachability is textual. It cannot tell a behavioural read from a decorative
 * one, and three of the nine census knobs died with a property access as their
 * only reference:
 *
 *  - `embedding-encoder`'s `runtime` / `backend` — read into
 *    `logger.withTags({ runtime: this.config.runtime, ... })`. A log tag is a
 *    read. The `backend` select's CUDA/CoreML options promised hardware
 *    acceleration that has never existed on any path.
 *  - `audio-analyzer`'s `selectedAudioModel` — read into a `logger.info` meta
 *    field. `createAudioPipeline` takes a backend and no model id.
 *
 * No static rule distinguishes those from a real consumer without deciding what
 * a "real" consumer is, and a guard that decides that produces false failures
 * on the first legitimate diagnostic read. So this guard is deliberately the
 * NARROW one: it never fires on a key that is referenced at all, and it fires
 * with certainty on a key that is not. It would have caught four of the nine,
 * and it will catch the tenth of that shape — which is the shape that recurs,
 * because a knob nobody ever wired is the knob nobody ever mentions again.
 *
 * The other three shapes are covered by the census's own discipline: a select
 * whose options name a capability (a runtime, a device, a model) must be traced
 * to the code that switches on it before it ships.
 *
 * ## Scope
 *
 * Declarations are read from files that build a settings schema (they mention
 * `globalSettingsSchema`, `ConfigSection`, `ConfigUISchema` or `this.schema(`)
 * under `packages/`. `info` / `separator` / `group` / `sub-tabs` /
 * `widget` rows and `readonlyField: true` readouts are LAYOUT, not knobs, and
 * carry no reader obligation — they are skipped, exactly as the census
 * separated them (§4.3). `button`-family rows are skipped too: their live
 * identity is `action`, never `key`.
 *
 * `object-array` rows are readouts too — a display table whose rows arrive on
 * `value` at render time; the editable shape is `editable-array`, which IS
 * checked. And a field marked `disabled: true` is the same promise as
 * `readonlyField: true` made with the other flag.
 *
 * References are searched across `packages`, `server`, `apps` and `scripts`,
 * excluding `dist/`, `node_modules/` and `.d.ts`. TESTS ARE EXCLUDED on
 * purpose: a key that only a test reads is still dead in production, and every
 * one of the nine had test coverage.
 *
 * Usage: npx tsx scripts/check-settings-key-has-reader.ts
 */
import * as path from 'node:path'
import { type SourceFile, walkSources } from './lib/walk-sources.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
/**
 * Files that NAME dead keys and must never count as reading them.
 *
 * - this guard's own source — its header and `KNOWN_UNREAD` list every key it
 *   has ever caught;
 * - the retired-keys registry — a retirement spec exists precisely BECAUSE the
 *   key has no reader, so letting it count as one would make every retirement
 *   permanently hide the field it retires. Re-declaring a retired key in a
 *   schema is the exact regression this guard has to catch.
 */
const NAMES_DEAD_KEYS: readonly string[] = [
  path.join(ROOT, 'scripts', 'check-settings-key-has-reader.ts'),
  path.join(ROOT, 'packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts'),
]

/** Roots searched for both declarations and references. */
const SEARCH_ROOTS: readonly string[] = ['packages', 'server', 'apps', 'scripts']

/** A file must mention one of these to be scanned for field declarations. */
const SCHEMA_MARKERS: readonly string[] = [
  'globalSettingsSchema',
  'ConfigSection',
  'ConfigUISchema',
  'this.schema(',
]

/**
 * Field `type`s that carry no reader obligation.
 *
 * Layout rows (`info`, `separator`, `group`, `sub-tabs`, `widget`, `qr-code`)
 * have a `key` only so React can address them. `button`-family rows dispatch on
 * their `action` string — `embedding.rebuild` is live while its `key` is read
 * nowhere, and flagging it would be a false failure on working code.
 */
const EXEMPT_FIELD_TYPES: ReadonlySet<string> = new Set([
  'info',
  'separator',
  'group',
  'sub-tabs',
  'widget',
  'qr-code',
  'button',
  'addon-action-button',
  'device-action-button',
  'addon-action-select',
  'account-sign-in',
  'secret-presence',
  'probe',
  // A display table: rows arrive on `value` at render time and the `key`
  // addresses the table, not a store key. The EDITABLE shape is
  // `editable-array`, which stays checked.
  'object-array',
])

/**
 * Declared keys with no reader, known on the day this guard was written.
 *
 * **SHRINK-ONLY, and it is not the allow-list this guard replaces.** The spec
 * it supersedes pinned two names that had ALREADY been deleted — it asserted
 * absence, so it could never fail on anything new. This list is the opposite:
 * every name in it is a LIVE defect the guard found and the session that wrote
 * the guard did not own the file to fix. The guard fails if a name here becomes
 * unnecessary, so the list cannot quietly outlive its contents, and a NEW dead
 * knob can never land in it — a new knob simply fails.
 *
 * Empty since 2026-09-27: its last entry, gotify's `verifyTls` (a "Verify TLS
 * certificate" switch no fetch ever received, found 2026-08-28, D272), was
 * deleted. It had started to read as "wired" only because D634 named it in the
 * adapter's `destinationKeys` — a mention, not a reader.
 */
const KNOWN_UNREAD: ReadonlySet<string> = new Set<string>()

/** One declared settings field. */
interface DeclaredKey {
  readonly key: string
  readonly fieldType: string
  readonly file: string
  readonly line: number
}

/** A key with no non-declaration reference anywhere. */
interface UnreadKey {
  readonly declared: DeclaredKey
  readonly declarationSites: readonly string[]
}

/** Every production source file under the search roots (tracked, no tests). */
function sourceFiles(): readonly SourceFile[] {
  return walkSources(ROOT, SEARCH_ROOTS, { extensions: ['.ts', '.tsx'] })
}

const KEY_LINE = /^\s*key:\s*'([A-Za-z_$][\w$]*)'\s*,?\s*$/
const TYPE_LINE = /^\s*type:\s*'([a-z-]+)'(\s+as\s+const)?\s*,?\s*$/
const READONLY_FIELD_LINE = /^\s*(readonlyField|disabled):\s*true\s*,?\s*$/

/**
 * Collect declared field keys from one schema file.
 *
 * The repo writes a field object as `{ type: '<t>', key: '<k>', ... }` — type
 * first. The scan binds a `key:` line to the nearest `type:` line above it
 * within {@link TYPE_LOOKBACK} lines, and `readonlyField: true` is searched in
 * the same window BELOW. A `key:` with no bindable type is not a settings field
 * (it is a `key` property of something else) and is dropped rather than guessed
 * at — a mis-parse must yield silence, never a wrong accusation.
 */
const TYPE_LOOKBACK = 4
const READONLY_LOOKAHEAD = 12

function declaredKeysIn(file: string, lines: readonly string[]): readonly DeclaredKey[] {
  const out: DeclaredKey[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const keyMatch = KEY_LINE.exec(line)
    if (keyMatch === null) continue
    const key = keyMatch[1]
    if (key === undefined) continue

    let fieldType: string | null = null
    for (let back = 1; back <= TYPE_LOOKBACK && i - back >= 0; back++) {
      const candidate = lines[i - back]
      if (candidate === undefined) continue
      const typeMatch = TYPE_LINE.exec(candidate)
      if (typeMatch !== null) {
        fieldType = typeMatch[1] ?? null
        break
      }
    }
    if (fieldType === null) continue
    if (EXEMPT_FIELD_TYPES.has(fieldType)) continue

    let readonlyField = false
    for (let ahead = 1; ahead <= READONLY_LOOKAHEAD && i + ahead < lines.length; ahead++) {
      const candidate = lines[i + ahead]
      if (candidate === undefined) continue
      if (READONLY_FIELD_LINE.test(candidate)) {
        readonlyField = true
        break
      }
      // A new field object started — stop looking.
      if (KEY_LINE.test(candidate) || TYPE_LINE.test(candidate)) break
    }
    if (readonlyField) continue

    out.push({ key, fieldType, file: path.relative(ROOT, file), line: i + 1 })
  }
  return out
}

/**
 * Is this occurrence of `key` on `line` a DECLARATION rather than a read?
 *
 * Two shapes only, both listed in the module header. Everything else counts as
 * a read, which is the safe direction: an over-broad "read" makes the guard
 * quiet, an over-broad "declaration" makes it accuse working code.
 */
function isDeclarationShaped(line: string, key: string): boolean {
  const escaped = key.replace(/[$]/g, '\\$')
  // `key: 'name'` — the field declaration.
  if (new RegExp(`\\bkey:\\s*['"\`]${escaped}['"\`]`).test(line)) return true
  // `name:` as a property / interface member / zod field / defaults entry.
  // Anchored on a boundary that is NOT a dot, so `foo.name:` never matches.
  if (new RegExp(`(^|[^.\\w$])${escaped}\\??\\s*:`).test(line)) return true
  return false
}

/**
 * Is `line` nothing but a comment?
 *
 * A key named in PROSE is not read by anything. This guard's own header names
 * every key it has ever caught, and a docblock that keeps a dead knob alive
 * would make the guard permanently blind to the thing it documents.
 */

/** Does `line` mention `key` as a whole word at all? */
function mentions(line: string, key: string): boolean {
  const escaped = key.replace(/[$]/g, '\\$')
  return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(line)
}

function main(): void {
  const files = sourceFiles()

  // ── Pass 1: declarations ────────────────────────────────────────────
  const declared: DeclaredKey[] = []
  for (const { file, rel, source } of files) {
    if (!rel.startsWith('packages/')) continue
    if (!SCHEMA_MARKERS.some((marker) => source.includes(marker))) continue
    declared.push(...declaredKeysIn(file, source.split('\n')))
  }

  // ── Pass 2: references ──────────────────────────────────────────────
  // One pass over every production file, asking each declared key whether this
  // line reads it. Keys are deduplicated by NAME: two addons may declare the
  // same key, and one reader anywhere keeps the name alive — the guard's claim
  // is "this identifier is referenced nowhere", never "addon X reads it".
  const byName = new Map<string, DeclaredKey[]>()
  for (const entry of declared) {
    const bucket = byName.get(entry.key) ?? []
    bucket.push(entry)
    byName.set(entry.key, bucket)
  }

  // ONE alternation over every still-unread name, tested once per line; the
  // per-name `mentions()` is asked only for the names that alternation found.
  // The previous shape built a fresh RegExp per (line × key) — 66 s on
  // 2026-09-20 for a question that is O(lines).
  const read = new Set<string>()
  const declarationSites = new Map<string, string[]>()
  const anyName = (): RegExp | null => {
    const pending = [...byName.keys()].filter((n) => !read.has(n))
    if (pending.length === 0) return null
    const escaped = pending.map((n) => n.replace(/[$]/g, '\\$')).join('|')
    return new RegExp(`(^|[^\\w$])(${escaped})(?=[^\\w$]|$)`, 'g')
  }
  for (const { file, rel, code } of files) {
    if (NAMES_DEAD_KEYS.includes(file)) continue
    // `code`, not `source`: a comment naming a key is not a reader of it.
    const lines = code.split('\n')
    let probe = anyName()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || probe === null) continue
      const found = new Set<string>()
      for (const m of line.matchAll(probe)) if (m[2] !== undefined) found.add(m[2])
      if (found.size === 0) continue
      for (const name of found) {
        if (read.has(name)) continue
        if (!mentions(line, name)) continue
        if (isDeclarationShaped(line, name)) {
          const sites = declarationSites.get(name) ?? []
          if (sites.length < 8) sites.push(`${rel}:${i + 1}`)
          declarationSites.set(name, sites)
          continue
        }
        read.add(name)
        probe = anyName()
      }
    }
  }

  const unread: UnreadKey[] = []
  for (const [name, entries] of byName) {
    if (read.has(name)) continue
    if (KNOWN_UNREAD.has(name)) continue
    const first = entries[0]
    if (first === undefined) continue
    unread.push({ declared: first, declarationSites: declarationSites.get(name) ?? [] })
  }
  unread.sort((a, b) => a.declared.key.localeCompare(b.declared.key))

  // SHRINK-ONLY: a backlog entry that is no longer a defect must LEAVE the
  // list. Otherwise the list outlives its contents and starts reading as a
  // permanent exemption — which is how the two-name spec this guard replaces
  // became decorative.
  const staleBacklog = [...KNOWN_UNREAD].filter((name) => !byName.has(name) || read.has(name))
  if (staleBacklog.length > 0) {
    console.error(
      `  ✘ KNOWN_UNREAD names that are no longer unread: ${staleBacklog.join(', ')}\n` +
        '    Each was wired or deleted — remove it from KNOWN_UNREAD in\n' +
        '    scripts/check-settings-key-has-reader.ts. The list is shrink-only.',
    )
    process.exitCode = 1
  }

  if (unread.length === 0) {
    if (staleBacklog.length === 0) {
      console.log(
        `  ✔ settings-key reader guard passed (${byName.size} declared keys, ` +
          `${KNOWN_UNREAD.size} in the shrink-only backlog)`,
      )
    }
    return
  }

  console.error('  ✘ settings keys declared with NO reader anywhere:\n')
  for (const entry of unread) {
    console.error(
      `    ${entry.declared.key}  (${entry.declared.fieldType})  ` +
        `${entry.declared.file}:${entry.declared.line}`,
    )
    for (const site of entry.declarationSites) console.error(`        declaration-only: ${site}`)
  }
  console.error(
    '\n  Every appearance of these names is a declaration, a default or a type\n' +
      '  member. An operator can set them and nothing reads the value back.\n' +
      '  Delete the field (and retire the stored key in\n' +
      '  packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts),\n' +
      '  or wire it to the code that should have been honouring it.\n' +
      '  See docs/decisions/adr-0268.md.',
  )
  process.exitCode = 1
}

main()
