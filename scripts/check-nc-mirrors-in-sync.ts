/**
 * The viewer (`camstack/`) keeps hand MIRRORS of notification-center shapes it
 * cannot import, and nothing kept them equal (final review m4). This makes
 * "they are the same" checkable instead of promised.
 *
 * Why mirrors at all: the timelapse and digest clearable-key lists are
 * ADDON-local (a timelapse rides no cap, so the list is not in
 * `@camstack/types`), and the viewer resolves `@camstack/types` from a
 * PUBLISHED release, so even the rule-family list is copied there. A key the
 * addon learns to clear and the viewer does not is a field the phone can never
 * empty; a key the viewer sends and the addon does not know is refused by its
 * enum — or, on an older addon, stripped and "saved" (I4).
 *
 * Checked:
 *  - each viewer clearable-key enum equals its authority, as a SET of literals;
 *  - the viewer's RULE-KIND enum equals the cap's `NcRuleKindSchema`, and its
 *    SYSTEM-EVENT-KIND enum the cap's `NcSystemEventKindSchema`. A pair MAY
 *    carry an explicit, self-expiring `aheadOfViewer` allowance for keys the
 *    hub ships before the viewer OTA learns them (the D637 families were the
 *    case it was built for). Each allowed key must be IN the authority and NOT
 *    in the viewer — the moment the viewer gains one, the check fails until the
 *    allowance is deleted, so an allowance cannot outlive the gap it covers.
 *    (The D642 tank kinds were once allowed through
 *    `NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS`; the viewer mirrors them now,
 *    and that list outlives the gap — it protects the phones that have not
 *    INSTALLED the build — so it is no longer read as an allowance);
 *    the mirror image is `retiredInViewer` (D692): keys the authority REMOVED and
 *    the viewer may still carry. Each must be ABSENT from the authority and
 *    PRESENT in the viewer, so it too fails the day the viewer drops the key;
 *  - the enum the viewer parses a SERVED template-var descriptor's `kinds`
 *    with accepts every kind the cap may serve (`NcTemplateVarKindSchema`, the
 *    frozen pre-D637 five), and the enum it parses `systemEventKinds` with
 *    accepts every system-event kind the catalog SERVES (the cap's minus the
 *    held-back ones, D642). One served kind the viewer's enum lacks fails the
 *    WHOLE catalog parse on every installed phone (D637, Task 2 C1);
 *  - each viewer z.object MIRROR of a cap schema has the same top-level KEYS
 *    as the cap. The viewer re-emits `conditions` as a FULL replacement, so a
 *    key the cap has and the mirror lacks is STRIPPED the first time the rule
 *    is saved from the phone — `excludeDeviceIds` (D636) would have vanished
 *    from every rule an operator touched on the phone. The RULE CONDITIONS
 *    themselves (`NcConditionsSchema`) are checked the same way since D640 —
 *    a key the viewer lacks is DROPPED by a phone save (for `devicesExclude`
 *    that WIDENS the rule to the excluded devices);
 *  - `pruneBannerFor` — the D315 prune-banner decision, in the admin UI and in
 *    the viewer — is the same function once the one legitimate difference, the
 *    record's type name, is normalised. Two copies that drift make the two UIs
 *    disagree about whether a rule was switched off by a deletion.
 *
 * Runs in the pre-commit hook, where the submodule is on disk. When it is
 * absent (CI checks out without submodules, a fresh worktree) it SAYS it did
 * not look — "I could not look" and "it is fine" are different answers (D315);
 * the precedent is `check-device-selection-in-sync.ts`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Where a string-literal list lives: the file, and the text that opens it. */
interface ListSource {
  readonly path: string
  /** The list starts at the first `[` after this marker. */
  readonly marker: string
}

interface KeyListPair {
  readonly label: string
  readonly authority: ListSource
  readonly viewer: ListSource
  /**
   * Keys the authority has and the viewer is ALLOWED to lack, for now. Every
   * entry must be in the authority and absent from the viewer; either failing
   * is a problem, so the allowance is deleted the day the viewer catches up.
   */
  readonly aheadOfViewer?: readonly string[]
}

/** Where the system-event kinds the served template catalog holds back live. */
const HELD_BACK_SYSTEM_EVENT_KINDS: ListSource = {
  path: 'packages/types/src/notification/template-vars.ts',
  marker: 'export const NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] =',
}

const KEY_LISTS: readonly KeyListPair[] = [
  {
    label: 'timelapse clearable keys',
    authority: {
      path: 'packages/addon-post-analysis/src/notification-center/timelapse/timelapse-rule-clear.ts',
      marker: 'export const TIMELAPSE_RULE_CLEARABLE_KEYS =',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcTimelapseRuleClearableKeySchema = z.enum(',
    },
  },
  {
    label: 'digest clearable keys',
    authority: {
      path: 'packages/addon-post-analysis/src/notification-center/summary/summary-rule-clear.ts',
      marker: 'export const SUMMARY_RULE_CLEARABLE_KEYS =',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcSummaryRuleClearableKeySchema = z.enum(',
    },
  },
  {
    label: 'rule clearable keys',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NC_RULE_CLEARABLE_KEYS =',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcRuleClearableKeySchema = z.enum(',
    },
  },
  {
    label: 'rule kinds',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcRuleKindSchema = z.enum(',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcRuleKindSchema = z.enum(',
    },
  },
  {
    // A kind the viewer lacks costs the operator the WHOLE rule on the phone
    // (its per-rule parse drops it).
    label: 'system-event kinds',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcSystemEventKindSchema = z.enum(',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcSystemEventKindSchema = z.enum(',
    },
  },
]

/**
 * The enum a viewer z.object field parses with, found by reading the field
 * (`<field>: z.array(<Enum>)`) — so the check follows the viewer if it splits
 * the served-descriptor kinds from the rule kinds, as it must once the rule
 * kinds widen.
 */
interface FieldEnumSource {
  readonly path: string
  readonly objectMarker: string
  readonly field: string
}

interface AcceptsAllPair {
  readonly label: string
  readonly authority: ListSource
  /** Members of the authority the hub does NOT serve (held back). */
  readonly minus?: ListSource
  readonly viewer: FieldEnumSource
}

const ACCEPTS_ALL: readonly AcceptsAllPair[] = [
  {
    label: 'served template-var descriptor kinds',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcTemplateVarKindSchema = z.enum(',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      objectMarker: 'export const NcTemplateVarDescriptorSchema = z.object(',
      field: 'kinds',
    },
  },
  {
    label: 'served template-var descriptor system-event kinds',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcSystemEventKindSchema = z.enum(',
    },
    minus: HELD_BACK_SYSTEM_EVENT_KINDS,
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      objectMarker: 'export const NcTemplateVarDescriptorSchema = z.object(',
      field: 'systemEventKinds',
    },
  },
]

/** A `z.object({ … })` whose top-level keys must match between the two sides. */
interface SchemaKeysPair {
  readonly label: string
  /** The object starts at the first `{` after this marker. */
  readonly authority: ListSource
  readonly viewer: ListSource
  /** Same self-expiring allowance as {@link KeyListPair.aheadOfViewer}. */
  readonly aheadOfViewer?: readonly string[]
  /**
   * The mirror of `aheadOfViewer`: keys the authority REMOVED that the viewer may still carry
   * until its own release drops them. Every entry must be ABSENT from the authority and
   * PRESENT in the viewer; either failing is a problem, so the allowance is deleted the day
   * the viewer catches up.
   */
  readonly retiredInViewer?: readonly string[]
}

const SCHEMA_KEYS: readonly SchemaKeysPair[] = [
  {
    label: 'system-event condition keys',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcSystemEventConditionSchema = z.object(',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcSystemEventConditionSchema = z.object(',
    },
  },
  {
    label: 'rule condition keys',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcConditionsSchema = z.object(',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcConditionsSchema = z.object(',
    },
  },
  {
    // The RULE's own top-level keys. A key the viewer lacks is invisible on the
    // phone; it survives a phone save only through the hub's patch merge.
    label: 'rule input keys',
    authority: {
      path: 'packages/types/src/capabilities/notification-rules.cap.ts',
      marker: 'export const NcRuleInputSchema = z.object(',
    },
    viewer: {
      path: 'camstack/src/data/notification-center.ts',
      marker: 'export const NcRuleInputSchema = z.object(',
    },
  },
]

interface FunctionPair {
  readonly label: string
  readonly name: string
  readonly admin: string
  readonly viewer: string
  /** Viewer spelling → admin spelling, applied to the viewer copy. */
  readonly renames: Readonly<Record<string, string>>
}

const FUNCTIONS: readonly FunctionPair[] = [
  {
    label: 'prune banner decision',
    name: 'pruneBannerFor',
    admin: 'packages/addon-admin-ui/src/pages/system/notification-prunes.ts',
    viewer: 'camstack/src/data/nc-prunes.ts',
    renames: { NcPruneRecord: 'NcPruneView' },
  },
]

const problems: string[] = []
const notes: string[] = []
let checked = 0
let skipped = 0

/** The file's text; `null` = a VIEWER file that is absent (not checked out). */
function read(path: string): string | null {
  const full = join(ROOT, path)
  if (existsSync(full)) return readFileSync(full, 'utf8')
  if (path.startsWith('camstack/')) return null
  problems.push(`${path} is missing — it is in THIS repository`)
  return null
}

/**
 * Comments out of the way before a list is read as text: an enum documented
 * member by member (`NcSystemEventKindSchema`) carries apostrophes and
 * brackets in its comments, and a reader that saw them would read the prose.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The string literals of the bracketed list after `marker`, or an error line. */
function literals(src: string, source: ListSource): readonly string[] | string {
  const at = src.indexOf(source.marker)
  if (at === -1) return `${source.path}: \`${source.marker}\` not found`
  const code = stripComments(src.slice(at + source.marker.length))
  const open = code.indexOf('[')
  const close = open === -1 ? -1 : code.indexOf(']', open)
  if (open === -1 || close === -1) return `${source.path}: no [...] list after \`${source.marker}\``
  const items = [...code.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
  if (items.length === 0)
    return `${source.path}: the list after \`${source.marker}\` is empty — the read is broken`
  return items
}

/** The `z.enum([...])` a field of the object after `objectMarker` parses with. */
function fieldEnum(src: string, source: FieldEnumSource): readonly string[] | string {
  const at = src.indexOf(source.objectMarker)
  if (at === -1) return `${source.path}: \`${source.objectMarker}\` not found`
  const close = src.indexOf('\n})', at)
  const body = src.slice(at, close === -1 ? undefined : close)
  const match = new RegExp(`^ {2}${source.field}\\??: z\\.array\\((\\w+)\\)`, 'm').exec(body)
  const name = match?.[1]
  if (name === undefined)
    return `${source.path}: \`${source.field}: z.array(<Enum>)\` not found in \`${source.objectMarker}\``
  return literals(src, { path: source.path, marker: `export const ${name} = z.enum(` })
}

/**
 * The top-level keys of the `z.object({ … })` after `marker`: every line inside
 * the braces at exactly two spaces of indent that opens with `key:`. The object
 * ends at the first line that is exactly `})`.
 */
function objectKeys(src: string, source: ListSource): readonly string[] | string {
  const at = src.indexOf(source.marker)
  if (at === -1) return `${source.path}: \`${source.marker}\` not found`
  const open = src.indexOf('{', at + source.marker.length)
  const close = open === -1 ? -1 : src.indexOf('\n})', open)
  if (open === -1 || close === -1) return `${source.path}: no {...} after \`${source.marker}\``
  const keys = [...src.slice(open + 1, close).matchAll(/^ {2}([A-Za-z_]\w*)\??:/gm)].map(
    (m) => m[1] ?? '',
  )
  if (keys.length === 0)
    return `${source.path}: the object after \`${source.marker}\` has no keys — the read is broken`
  return keys
}

/** `export function <name>(` through the first line that is exactly `}`. */
function functionText(
  src: string,
  name: string,
  path: string,
): string | { readonly error: string } {
  const start = src.indexOf(`export function ${name}(`)
  if (start === -1) return { error: `${path}: \`export function ${name}(\` not found` }
  const end = src.indexOf('\n}\n', start)
  if (end === -1) return { error: `${path}: \`${name}\` has no closing brace at column 0` }
  return src.slice(start, end + 2)
}

/**
 * Judge an `aheadOfViewer` allowance: every allowed key must be in the
 * authority and absent from the viewer, or the allowance has outlived its gap.
 * Returns the allowance (the keys the comparison may skip) and notes what it
 * allowed, so a green run still SAYS the viewer lags.
 */
function checkAllowance(
  label: string,
  ahead: readonly string[],
  authority: readonly string[],
  viewer: readonly string[],
  authorityPath: string,
): readonly string[] {
  for (const key of ahead) {
    if (!authority.includes(key)) {
      problems.push(
        `the ${label} allowance names \`${key}\`, which the authority does not have — ` +
          `delete it from aheadOfViewer in scripts/check-nc-mirrors-in-sync.ts (authority: ${authorityPath})`,
      )
    } else if (viewer.includes(key)) {
      problems.push(
        `the viewer's ${label} now carry \`${key}\` — the gap it was allowed for is ` +
          `closed: delete \`${key}\` from aheadOfViewer in scripts/check-nc-mirrors-in-sync.ts`,
      )
    }
  }
  const allowed = ahead.filter((key) => authority.includes(key) && !viewer.includes(key))
  if (allowed.length > 0) {
    notes.push(`${label}: the viewer is allowed to lack ${allowed.join(', ')} (aheadOfViewer)`)
  }
  return ahead
}

/**
 * Judge a `retiredInViewer` allowance, the mirror of {@link checkAllowance}: every entry must
 * be ABSENT from the authority (it was removed) and PRESENT in the viewer (it still carries
 * it), or the allowance has outlived the gap. Returns the keys the `extra` comparison skips.
 */
function checkRetiredAllowance(
  label: string,
  retired: readonly string[],
  authority: readonly string[],
  viewer: readonly string[],
  authorityPath: string,
): readonly string[] {
  for (const key of retired) {
    if (authority.includes(key)) {
      problems.push(
        `the ${label} allowance retiredInViewer names \`${key}\`, which the authority STILL has — ` +
          `delete it from retiredInViewer in scripts/check-nc-mirrors-in-sync.ts (authority: ${authorityPath})`,
      )
    } else if (!viewer.includes(key)) {
      problems.push(
        `the viewer's ${label} no longer carry \`${key}\` — the gap it was allowed for is ` +
          `closed: delete \`${key}\` from retiredInViewer in scripts/check-nc-mirrors-in-sync.ts`,
      )
    }
  }
  const allowed = retired.filter((key) => !authority.includes(key) && viewer.includes(key))
  if (allowed.length > 0) {
    notes.push(
      `${label}: the viewer is allowed to still carry ${allowed.join(', ')} (retiredInViewer)`,
    )
  }
  return retired
}

/** A list read from THIS repository; a broken read is a problem. */
function readRepoList(source: ListSource): readonly string[] {
  const src = read(source.path)
  if (src === null) return []
  const keys = literals(src, source)
  if (typeof keys === 'string') {
    problems.push(keys)
    return []
  }
  return keys
}

for (const pair of KEY_LISTS) {
  const authoritySrc = read(pair.authority.path)
  const viewerSrc = read(pair.viewer.path)
  if (authoritySrc === null) continue
  if (viewerSrc === null) {
    skipped++
    continue
  }
  const authority = literals(authoritySrc, pair.authority)
  const viewer = literals(viewerSrc, pair.viewer)
  if (typeof authority === 'string') problems.push(authority)
  if (typeof viewer === 'string') problems.push(viewer)
  if (typeof authority === 'string' || typeof viewer === 'string') continue
  const ahead = checkAllowance(
    pair.label,
    pair.aheadOfViewer ?? [],
    authority,
    viewer,
    pair.authority.path,
  )
  const missing = authority.filter((key) => !viewer.includes(key) && !ahead.includes(key))
  const extra = viewer.filter((key) => !authority.includes(key))
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      `the ${pair.label} differ:\n` +
        `    authority: ${pair.authority.path}\n    viewer:    ${pair.viewer.path}\n` +
        (missing.length > 0 ? `    missing in the viewer: ${missing.join(', ')}\n` : '') +
        (extra.length > 0 ? `    only in the viewer:    ${extra.join(', ')}` : ''),
    )
  }
  checked++
}

for (const pair of SCHEMA_KEYS) {
  const authoritySrc = read(pair.authority.path)
  const viewerSrc = read(pair.viewer.path)
  if (authoritySrc === null) continue
  if (viewerSrc === null) {
    skipped++
    continue
  }
  const authority = objectKeys(authoritySrc, pair.authority)
  const viewer = objectKeys(viewerSrc, pair.viewer)
  if (typeof authority === 'string') problems.push(authority)
  if (typeof viewer === 'string') problems.push(viewer)
  if (typeof authority === 'string' || typeof viewer === 'string') continue
  const ahead = checkAllowance(
    pair.label,
    pair.aheadOfViewer ?? [],
    authority,
    viewer,
    pair.authority.path,
  )
  const retired = checkRetiredAllowance(
    pair.label,
    pair.retiredInViewer ?? [],
    authority,
    viewer,
    pair.authority.path,
  )
  const missing = authority.filter((key) => !viewer.includes(key) && !ahead.includes(key))
  const extra = viewer.filter((key) => !authority.includes(key) && !retired.includes(key))
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      `the ${pair.label} differ:\n` +
        `    authority: ${pair.authority.path}\n    viewer:    ${pair.viewer.path}\n` +
        (missing.length > 0
          ? `    missing in the viewer (STRIPPED on a phone save): ${missing.join(', ')}\n`
          : '') +
        (extra.length > 0 ? `    only in the viewer:    ${extra.join(', ')}` : ''),
    )
  }
  checked++
}

for (const pair of ACCEPTS_ALL) {
  const authoritySrc = read(pair.authority.path)
  const viewerSrc = read(pair.viewer.path)
  if (authoritySrc === null) continue
  if (viewerSrc === null) {
    skipped++
    continue
  }
  const authority = literals(authoritySrc, pair.authority)
  const viewer = fieldEnum(viewerSrc, pair.viewer)
  if (typeof authority === 'string') problems.push(authority)
  if (typeof viewer === 'string') problems.push(viewer)
  if (typeof authority === 'string' || typeof viewer === 'string') continue
  const heldBack = pair.minus === undefined ? [] : readRepoList(pair.minus)
  const unparseable = authority.filter((key) => !viewer.includes(key) && !heldBack.includes(key))
  if (unparseable.length > 0) {
    problems.push(
      `the viewer cannot parse all ${pair.label}:\n` +
        `    authority: ${pair.authority.path}\n    viewer:    ${pair.viewer.path} (\`${pair.viewer.field}\`)\n` +
        `    served but not accepted: ${unparseable.join(', ')} — one such descriptor fails the whole catalog parse`,
    )
  }
  // Held back, and this viewer already parses them: the hub may serve them
  // once the phones have INSTALLED a build that does — never before.
  const parseableHeldBack = heldBack.filter((key) => viewer.includes(key))
  if (parseableHeldBack.length > 0) {
    notes.push(
      `${pair.label}: held back but parsed by this viewer: ${parseableHeldBack.join(', ')} — ` +
        'serve them again (NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS) once its OTA is installed',
    )
  }
  checked++
}

for (const pair of FUNCTIONS) {
  const adminSrc = read(pair.admin)
  const viewerSrc = read(pair.viewer)
  if (adminSrc === null) continue
  if (viewerSrc === null) {
    skipped++
    continue
  }
  const admin = functionText(adminSrc, pair.name, pair.admin)
  const rawViewer = functionText(viewerSrc, pair.name, pair.viewer)
  if (typeof admin !== 'string') problems.push(admin.error)
  if (typeof rawViewer !== 'string') problems.push(rawViewer.error)
  if (typeof admin !== 'string' || typeof rawViewer !== 'string') continue
  const viewer = Object.entries(pair.renames).reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    rawViewer,
  )
  if (admin !== viewer) {
    const lines = { admin: admin.split('\n'), viewer: viewer.split('\n') }
    const at = lines.admin.findIndex((line, i) => line !== lines.viewer[i])
    const lineNo = at === -1 ? Math.min(lines.admin.length, lines.viewer.length) + 1 : at + 1
    problems.push(
      `the ${pair.label} copies of \`${pair.name}\` differ (first at line ${String(lineNo)} of the function):\n` +
        `    admin:  ${pair.admin}\n    viewer: ${pair.viewer}\n` +
        `    admin  > ${lines.admin[lineNo - 1] ?? '<end of function>'}\n` +
        `    viewer > ${lines.viewer[lineNo - 1] ?? '<end of function>'}`,
    )
  }
  checked++
}

if (problems.length > 0) {
  console.error('✗ notification-center mirrors guard')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
if (skipped > 0) {
  console.log(`  ✔ nc mirrors: authority files present`)
  console.log(
    `  ⊘ viewer mirrors NOT checked: the camstack/ submodule is not checked out here — run \`git submodule update --init camstack\` to check them`,
  )
} else {
  console.log(`  ✔ nc mirrors: ${String(checked)} viewer mirrors match their authority`)
  for (const note of notes) console.log(`  ⊘ ${note}`)
}
