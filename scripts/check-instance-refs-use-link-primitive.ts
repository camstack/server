#!/usr/bin/env tsx
/**
 * An instance that points at another instance does it through the ONE link primitive (D1013 rule 5):
 * `linkField` in a kind declared with `declareLinkKind`, drawn by `instance-select`, REQUIRED id.
 * The target's owner refuses `deleteInstance` while a link names it, which only works when the link
 * is declared where the hub can read it. Four rules, one baseline.
 *
 * 1. A `type: 'broker-select'` literal is a violation: the broker-only picker is the superseded
 *    spelling of `instance-select`. Present uses are the baseline until step B8 deletes them.
 * 2. In an addon source (`packages/addon-*` except the admin UI), a zod or form key shaped like a
 *    reference to another instance (`brokerId`, `connectionId`, `accountId`, `smtpInstanceId`,
 *    `relayId`, `mailboxId`, `calendarIds`) must sit in a file that imports `declareLinkKind` or
 *    `linkField` from `@camstack/types`, or be listed in `scripts/instance-links-baseline.json`
 *    as `<package>:<path under src>:<key>`.
 * 3. The baseline only SHRINKS: every entry must still match a real violation; a migrated site
 *    leaves the list in the same change.
 * 4. Every `declareLinkKind(` call names, in each `cap:` it carries, a collection capability that
 *    exists (`mode: 'collection'` in a `*.cap.ts`).
 *
 * A device class (`devices/`) keeps the id of the instance that owns it, and a custom action takes an
 * instance id as an input: neither is a stored link between two instances, so rule 2 skips them.
 *
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-instance-refs-use-link-primitive.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, walk } from './check-integration-instances-declared.ts'

export const BASELINE_FILE = path.join(ROOT, 'scripts', 'instance-links-baseline.json')

const BROKER_SELECT_RE = /\btype:\s*['"]broker-select['"]/
const REF_KEY = String.raw`(?:[a-z]+)?(?:[Bb]rokerId|[Ii]nstanceId|[Cc]onnectionId|[Rr]elayId|[Mm]ailboxId|[Aa]ccountId)|calendarIds`
/** Keys that match the shape and are not a reference to an instance. */
const NOT_AN_INSTANCE_REF: ReadonlySet<string> = new Set([
  // A Cloudflare tenant id typed by the operator, not the id of a CamStack instance.
  'customAccountId',
])
/**
 * Sites (`<package>:<path under src>:<key>`) whose key matches the shape and never will be a link to
 * another CamStack instance. Each carries its reason.
 */
export const NOT_AN_INSTANCE_REF_SITES: ReadonlyMap<string, string> = new Map([
  [
    'addon-cloudflare:tunnel/cloudflare-actions.ts:accountId',
    'a Cloudflare account id typed or discovered at the Cloudflare API, not a CamStack instance',
  ],
  [
    'addon-provider-vesync:config.ts:accountId',
    'the VeSync cloud account id the vendor returns at sign-in, not a CamStack instance',
  ],
  [
    'addon-terminal:terminal-camera-device.ts:instanceId',
    'the terminal session instance a terminal camera device attaches to, not an integration instance',
  ],
  [
    'addon-provider-reolink:email-push-bridge.ts:brokerId',
    'an event-schema field and private plumbing of the single default mailbox, not a stored link',
  ],
  [
    'addon-import-alexa:alexa-login-routes.ts:brokerId',
    'a route body parameter and the id the commit returns, not a stored link',
  ],
  [
    'addon-provider-homeassistant:ha-device-source.ts:brokerId',
    'the provenance an adoption writes on the device it created, never picked by an operator',
  ],
])
/** A zod field (`brokerId: z.`) or a form field descriptor (`key: 'brokerId'`). */
const REF_DECL_RE = new RegExp(
  String.raw`(?:^|[\s,{(])(${REF_KEY})\??\s*:\s*z\s*\.|\bkey:\s*['"](${REF_KEY})['"]`,
  'gm',
)
/** Device classes and custom actions hold an owner id or an action input, not a link. */
const NOT_A_LINK_PATH_RE = /(?:^|\/)devices\/|(?:^|\/)custom-actions\.ts$/
const PRIMITIVE_IMPORT_RE =
  /import\s*(?:type\s*)?\{[^}]*\b(?:declareLinkKind|linkField|linkFieldDescriptor)\b[^}]*\}\s*from\s*['"]@camstack\/types['"]/
const DECLARE_LINK_KIND_RE = /\bdeclareLinkKind\s*[(<]/g
const CAP_LITERAL_RE = /\bcap:\s*['"]([^'"]+)['"]/g

export interface SourceFile {
  /** Relative to the repo root. */
  readonly path: string
  readonly source: string
}

export interface Violation {
  readonly id: string
  readonly message: string
}

/** The text of the call whose `(` is at or after `from`, balanced. */
function callText(source: string, from: number): string {
  const open = source.indexOf('(', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/** Rule 1 and 2: every violation site, as its baseline id. */
export function siteViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    if (BROKER_SELECT_RE.test(file.source)) {
      out.push({
        id: `broker-select:${file.path}`,
        message: `${file.path}: a 'broker-select' field type: use 'instance-select' through linkFieldDescriptor`,
      })
    }
    const addon = /^packages\/(addon-[^/]+)\/src\/(.+)$/.exec(file.path)
    if (addon?.[1] === undefined || addon[1] === 'addon-admin-ui') continue
    if (PRIMITIVE_IMPORT_RE.test(file.source)) continue
    if (NOT_A_LINK_PATH_RE.test(addon[2] ?? '')) continue
    const keys = new Set<string>()
    for (const match of file.source.matchAll(REF_DECL_RE)) {
      const key = match[1] ?? match[2]
      if (key !== undefined && !NOT_AN_INSTANCE_REF.has(key)) keys.add(key)
    }
    for (const key of keys) {
      const id = `${addon[1]}:${addon[2] ?? ''}:${key}`
      if (NOT_AN_INSTANCE_REF_SITES.has(id)) continue
      out.push({
        id,
        message: `${file.path}: '${key}' references another instance without declareLinkKind / linkField from @camstack/types`,
      })
    }
  }
  return out
}

/** Rule 4: every `declareLinkKind(` call names only caps that exist as collection caps. */
export function capViolations(
  files: readonly SourceFile[],
  collectionCaps: ReadonlySet<string>,
): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    if (!/^packages\/addon-[^/]+\/src\//.test(file.path)) continue
    for (const match of file.source.matchAll(DECLARE_LINK_KIND_RE)) {
      const call = callText(file.source, match.index ?? 0)
      for (const cap of call.matchAll(CAP_LITERAL_RE)) {
        const name = cap[1] ?? ''
        if (!collectionCaps.has(name)) {
          out.push({
            id: `cap:${file.path}:${name}`,
            message: `${file.path}: declareLinkKind links to '${name}', which is not a collection capability`,
          })
        }
      }
    }
  }
  return out
}

/** Rule 3 and the final verdict: what is new, and what is stale in the baseline. */
export function judge(
  found: readonly Violation[],
  baseline: readonly string[],
): { readonly fresh: Violation[]; readonly stale: string[] } {
  const listed = new Set(baseline)
  const ids = new Set(found.map((v) => v.id))
  return {
    fresh: found.filter((v) => !listed.has(v.id)),
    stale: baseline.filter((id) => !ids.has(id)),
  }
}

/** Names of capabilities declared `mode: 'collection'`. */
export function collectionCapsOf(capSources: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const source of capSources) {
    const name = /\bname:\s*['"]([^'"]+)['"]/.exec(source)?.[1]
    if (name !== undefined && /\bmode:\s*['"]collection['"]/.test(source)) names.add(name)
  }
  return names
}

function readSources(): SourceFile[] {
  const dirs: string[] = []
  const packagesDir = path.join(ROOT, 'packages')
  for (const name of readdirSync(packagesDir)) dirs.push(path.join(packagesDir, name, 'src'))
  dirs.push(path.join(ROOT, 'server', 'backend', 'src'))
  const paths: string[] = []
  for (const dir of dirs) walk(dir, paths)
  return paths.map((p) => ({
    path: path.relative(ROOT, p).split(path.sep).join('/'),
    source: readFileSync(p, 'utf-8'),
  }))
}

function readBaseline(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'))
  const entries: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'entries') : undefined
  return Array.isArray(entries) ? entries.filter((e): e is string => typeof e === 'string') : []
}

function main(): void {
  const files = readSources()
  const capDir = path.join(ROOT, 'packages', 'types', 'src', 'capabilities')
  const caps = collectionCapsOf(
    readdirSync(capDir)
      .filter((n) => n.endsWith('.cap.ts'))
      .map((n) => readFileSync(path.join(capDir, n), 'utf-8')),
  )
  const found = [...siteViolations(files), ...capViolations(files, caps)]
  const { fresh, stale } = judge(found, readBaseline())
  if (fresh.length === 0 && stale.length === 0) {
    console.log(
      `check-instance-refs-use-link-primitive: ${found.length} baselined site(s), ${files.length} sources read`,
    )
    return
  }
  console.error('check-instance-refs-use-link-primitive (D1013):')
  for (const v of fresh) console.error(`  ${v.message}  [${v.id}]`)
  for (const id of stale) {
    console.error(`  baseline entry no longer matches a violation, remove it: ${id}`)
  }
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
