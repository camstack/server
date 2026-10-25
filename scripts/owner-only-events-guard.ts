/**
 * The judgement of `check-owner-only-events.ts` (D224, D663), as a pure function
 * over source files — so each rule is proven red on a fixture.
 *
 * An owner-only event category (today: `device.native-shadow-changed`, the
 * native shadow of a claimed cap) must never reach a consumer surface: it would
 * be a second truth beside the merged slice (D224). Two structural rules:
 *
 *  (a) Only the composer SUBSCRIBES to it. The enum defines the category, the
 *      mirror emits it, the composer reads it. A file elsewhere naming the enum
 *      member or the string has a second consumer.
 *  (b) Every public event path filters with `isPublicEvent`. Under
 *      `server/backend/src/api/**`, every `getRecent(` and every `.subscribe(`
 *      on a bus must carry `isPublicEvent(` (or `publicRecent(`) INSIDE the
 *      call — in the handler, or in the chain the read feeds. The eighth path
 *      (`eventBusProxy.getRecent`) was found by a review because a raw
 *      forwarder subscribes to nothing BY NAME; a nominal guard cannot see it,
 *      a structural one can. `public-event-filter.ts` is the definer.
 *
 * A "bus" receiver is one whose last name segment is `eb`, `bus`, or contains
 * `event`/`bus` (case-insensitive): `eb`, `eventBus`, `ctx.eventBus`,
 * `systemEvents`. `logging.subscribe`, `toastService.subscribe`, `ls.subscribe`
 * are not event buses and are ignored. The judgement reads `code` (comments
 * blanked by `walk-sources`).
 *
 * Two blind spots, stated so nobody relies on the guard for them: rule (b) is
 * scoped to `server/backend/src/api/**` (the REPL's raw subscriber in
 * `core/repl/` is reached only through an admin procedure), and it names a bus
 * by receiver — a destructured `subscribe` or a receiver called `source` slips
 * past it. A router spec per public path remains the proof; this guard catches
 * the next `eb.subscribe(` / `getRecent(` someone adds beside them.
 */
import * as path from 'node:path'
import { type SourceFile, walkSources } from './lib/walk-sources.ts'

/** What the judgement reads of a file: its repo-relative path and its comment-free code. */
export type GuardFile = Pick<SourceFile, 'rel' | 'code'>

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** The real tree, as the CI step and the spec's last test read it. */
export function collectOwnerOnlyEventFiles(): readonly GuardFile[] {
  return walkSources(REPO_ROOT, ['packages', 'server', 'scripts'])
}

const SHADOW_NAME = /DeviceNativeShadowChanged|device\.native-shadow-changed/
const SHADOW_ALLOWED_PATHS: readonly string[] = [
  'packages/types/src/enums/event-category.ts',
  'packages/system/src/builtins/device-manager/device-state-mirror.ts',
  'scripts/check-owner-only-events.ts',
  'scripts/owner-only-events-guard.ts',
]
const SHADOW_ALLOWED_DIRS: readonly string[] = ['packages/system/src/builtins/composer/']

const PUBLIC_API_DIR = 'server/backend/src/api/'
const PUBLIC_FILTER_DEFINER = 'server/backend/src/api/core/public-event-filter.ts'
/** A history read: `x.getRecent(` — any receiver, the name is the bus's. */
const GET_RECENT = /\bgetRecent\s*\(/g
/** A subscription with its receiver chain: `a.b.subscribe(`. */
const SUBSCRIBE = /(?<![\w$.])((?:[\w$]+\.)*[\w$]+)\.subscribe\s*\(/g
const BUS_RECEIVER = /^(eb|bus)$|event|bus/i
const PREDICATE = /\bisPublicEvent\s*\(|\bpublicRecent\s*\(/

function isTest(rel: string): boolean {
  return rel.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(rel)
}

function isGenerated(rel: string): boolean {
  return rel.includes('/generated/') || /(^|\/)generated-[^/]+\.ts$/.test(rel)
}

/**
 * The text of a call from its opening `(` through the balanced `)` and any
 * calls chained straight onto it (`.filter(...)`, `.map(...)`). Unbalanced
 * input takes the rest of the file — the guard errs towards seeing more.
 */
export function callWindow(source: string, openParen: number): string {
  let depth = 0
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        // A call chained right onto this one: keep going.
        const chained = /^\s*\.\s*[\w$]+\s*\(/.exec(source.slice(i + 1))
        if (chained) {
          i += chained[0].length
          depth = 1
          continue
        }
        return source.slice(openParen, i + 1)
      }
    }
  }
  return source.slice(openParen)
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function checkShadowSubscribers(file: GuardFile, failures: string[]): void {
  if (SHADOW_ALLOWED_PATHS.includes(file.rel)) return
  if (SHADOW_ALLOWED_DIRS.some((dir) => file.rel.startsWith(dir))) return
  const hit = SHADOW_NAME.exec(file.code)
  if (hit) {
    failures.push(
      `${file.rel}:${lineOf(file.code, hit.index)}: names the owner-only category ${hit[0]} — only the ` +
        'composer subscribes to the native shadow; the enum defines it, the mirror emits it (D224, D663)',
    )
  }
}

function checkPublicPaths(file: GuardFile, failures: string[]): void {
  if (!file.rel.startsWith(PUBLIC_API_DIR) || file.rel === PUBLIC_FILTER_DEFINER) return
  if (isGenerated(file.rel)) return
  const { code } = file
  for (const match of code.matchAll(GET_RECENT)) {
    const window = callWindow(code, match.index + match[0].length - 1)
    if (!PREDICATE.test(window)) {
      failures.push(
        `${file.rel}:${lineOf(code, match.index)}: getRecent( without isPublicEvent — read history ` +
          'through publicRecent(...) so an owner-only category is never served (D224)',
      )
    }
  }
  for (const match of code.matchAll(SUBSCRIBE)) {
    const receiver = match[1] ?? ''
    const last = receiver.split('.').at(-1) ?? ''
    if (!BUS_RECEIVER.test(last)) continue
    const window = callWindow(code, match.index + match[0].length - 1)
    if (!PREDICATE.test(window)) {
      failures.push(
        `${file.rel}:${lineOf(code, match.index)}: ${receiver}.subscribe( whose handler does not ` +
          'filter with isPublicEvent(evt) — every public live path refuses owner-only categories (D224)',
      )
    }
  }
}

export function checkOwnerOnlyEventFacts(files: readonly GuardFile[]): readonly string[] {
  const failures: string[] = []
  for (const file of files) {
    if (isTest(file.rel)) continue
    checkShadowSubscribers(file, failures)
    checkPublicPaths(file, failures)
  }
  return failures
}
