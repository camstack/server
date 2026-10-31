/**
 * The authority behind a notification button.
 *
 * **Read this before changing anything here.** A button's URL travels through
 * third-party infrastructure — ntfy's server, a push relay, whatever forwarded
 * the message — and is therefore exactly as public as the notification is. The
 * operator decided (2026-08-05) that the token ALONE authorises the action:
 * there is no session check, and a tap does not identify who tapped. Whoever
 * holds the link can run that one action. [D47](../../../../docs/decisions/adr-0047.md).
 *
 * Everything in this file exists to bound that blast radius, since the
 * authorisation model does not:
 *
 *  - **One token, one action, one notification.** The record carries the rule,
 *    the sequence and the device, so a token cannot be re-pointed at anything
 *    else. There is no "run arbitrary sequence" shape to abuse.
 *  - **Single use, claimed ATOMICALLY.** `claim()` is the only way to read a
 *    record and it marks it spent in the same synchronous step, so two taps
 *    arriving together cannot both open a gate. This is why the registry is a
 *    plain in-process Map and not the settings store: a read-then-write across
 *    an async store is a race that a physical actuator would pay for.
 *  - **Short-lived, and the expiry is a COMPARISON, not a sweeper.** A reaper
 *    that failed would leave tokens live indefinitely — the same reasoning the
 *    snooze policy is built on. The sweep here only reclaims memory.
 *  - **In-memory is deliberate.** Tokens do not survive a hub restart, so a
 *    link can never outlive the process that minted it. The cost is real and
 *    accepted: a deploy kills the buttons on notifications already delivered,
 *    which with a short TTL were nearly dead anyway.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AlarmArmMode } from '@camstack/types'
import type { BboxRect } from '../pipeline-analytics/pipeline/zones/geometry.js'
import { ARM_ANYWAY_TTL_MS } from './alarm/alarm-arm-guard.js'

/** What every grant carries, whatever it does. */
interface NcActionGrantBase {
  /** Opaque, unguessable id — the path segment of the callback URL. */
  readonly id: string
  /** Subject device — for the log tag and for the runner's input. */
  readonly deviceId: number
  /** Button id, for the audit line. */
  readonly actionId: string
  /** Which delivery this token was minted for. Audit only — it does not
   *  authorise, and pretending otherwise would be the dangerous reading. */
  readonly targetId?: string
  readonly expiresAt: number
}

/** Run one shared sequence. The original grant. */
export interface NcSequenceGrant extends NcActionGrantBase {
  readonly kind: 'sequence'
  readonly ruleId: string
  readonly ruleName: string
  /** The shared sequence to run. Must exist in the store; the minter checks. */
  readonly sequenceId: string
}

/**
 * Open a snooze window on behalf of the person this notification was addressed
 * to.
 *
 * `userId` is frozen at MINT time and is the whole of the personal-window
 * decision — a token minted for Alice's phone can only ever silence Alice,
 * whoever taps it. That is what makes a public callback safe to hand a snooze:
 * the worst a forwarded notification buys is silencing the person it was
 * already addressed to.
 */
export interface NcSnoozeGrant extends NcActionGrantBase {
  readonly kind: 'snooze'
  readonly ruleId: string
  readonly ruleName: string
  /** Whose silence this is. Never the tapper's — see the docblock. */
  readonly userId: string
  readonly minutes: number
  /** The subject's class, so the window silences THIS animal and not the
   *  person who walks in after it. Absent = every class. */
  readonly classes?: readonly string[]
}

/**
 * Arm or disarm the panel from the notification that reported it.
 *
 * `panelDeviceId` is resolved at mint time from the node's own panel, so a
 * token cannot be re-pointed at somebody else's alarm.
 */
export interface NcAlarmMoveGrant extends NcActionGrantBase {
  readonly kind: 'alarm'
  readonly action: 'arm' | 'disarm'
  /** Set only for `arm`. */
  readonly mode?: AlarmArmMode
  readonly panelDeviceId: number
}

/**
 * The Arm anyway on ONE refusal notification (D630).
 *
 * It carries the refusal id and NOTHING else it could act on — no mode, no
 * device ids. The panel's refusal record is the authority on both, so a
 * forwarded or edited URL cannot widen what is excluded or arm a different
 * mode; a stale, spent or expired refusal is refused by the panel itself.
 */
export interface NcAlarmArmAnywayGrant extends NcActionGrantBase {
  readonly kind: 'alarm'
  readonly action: 'arm-anyway'
  readonly refusalId: string
  readonly panelDeviceId: number
}

/**
 * "Bypass this input until disarm", on ONE trigger notification.
 *
 * Frozen at mint from the ROW's `alarmSource`: the rule and the input device
 * whose match the notification reports, and nothing else — a forwarded or
 * edited URL cannot bypass a different input or a whole rule. `notedAt` is the
 * match's instant: the panel refuses a bypass about an arm session that is
 * already over (`stale`), and any bypass on a disarmed panel.
 */
export interface NcAlarmBypassInputGrant extends NcActionGrantBase {
  readonly kind: 'alarm'
  readonly action: 'bypass-input'
  readonly panelDeviceId: number
  readonly ruleId: string
  readonly ruleName: string
  readonly inputDeviceId: number
  readonly cameraId: number
  readonly notedAt: number
}

export type NcAlarmGrant = NcAlarmMoveGrant | NcAlarmArmAnywayGrant | NcAlarmBypassInputGrant

/**
 * A granted action that ran and was REFUSED for a reason the person holding
 * the phone can act on — "the alarm changed since this notification". Its
 * message is shown on the page the tap lands on; any other throw stays the
 * generic "it did not work".
 */
export class NcActionRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NcActionRefusedError'
  }
}

/**
 * Apply the addon updates ONE notification was about.
 *
 * The grant freezes **what** and **where** — the package names the row named
 * and the single node they are installed on — and deliberately freezes no
 * VERSION. A version stated by a notification is one the system read back
 * ([D313](../../../../docs/decisions/adr-0313-a-version-is-read-back-never-restated-and-unknown-is-an-absent-field.md)),
 * and the row's `latestVersion` is a registry observation from whenever the
 * 6-hourly check ran. Carrying it here would put a restated number on the wire
 * a second time, and pinning it would install something the registry no longer
 * offers. The one resolver (`LifecycleJobEngine.fetchAddonTask`) reads the real
 * version out of the staged tarball at apply time, and that answer is what
 * reaches the `addon.updated` notification.
 *
 * `nodeId` is REQUIRED and singular. A row that spans nodes mints no button —
 * see `addon-update-buttons.ts`.
 */
export interface NcAddonUpdateGrant extends NcActionGrantBase {
  readonly kind: 'addon-update'
  /** The packages the notification named, in the order it listed them. */
  readonly packages: readonly string[]
  /** The one node they are installed on. */
  readonly nodeId: string
}

/**
 * Stage a server update on ONE node.
 *
 * The grant freezes **where** — the node the notification named — and
 * deliberately freezes no VERSION (D313, D325). `checkServerUpdate` at tap
 * time is the authority for whether an update is still needed; pinning the
 * row's `latestVersion` would stage whatever the 6-hourly check observed.
 *
 * `nodeId` is REQUIRED and singular. A row that spans nodes mints no button —
 * see `server-update-buttons.ts`.
 */
export interface NcServerUpdateGrant extends NcActionGrantBase {
  readonly kind: 'server-update'
  /** The one node the notification named. */
  readonly nodeId: string
}

/**
 * "This detection was right / wrong": mark ONE track for retraining (#243).
 *
 * The grant freezes WHICH track (the one the notification reported), the
 * verdict, and — only on a "Wrong, it is a <class>" button — the class the
 * operator named. `userId` is the person the notification was addressed to,
 * frozen at MINT time: a tap identifies nobody (D47), so "who" is the owner of
 * the delivery, exactly as it is for a snooze. The worst a forwarded
 * notification buys is one more mark on a track its recipient was already
 * shown, bounded by the retrain staging budget.
 *
 * `viaLink` is set on the fallback for a channel with NO buttons: the URL sits
 * in the message body, where a link preview or a mail scanner will open it, so
 * a GET renders a confirm page and only the confirming POST claims the token.
 */
export interface NcDetectionVerdictGrant extends NcActionGrantBase {
  readonly kind: 'detection-verdict'
  /** `wrong-label`: the macro class was right, the label / sub-label was not. */
  readonly verdict: NcVerdictValue
  readonly trackId: string
  readonly ruleId: string
  readonly ruleName: string
  /** Whose notification this was. Never the tapper's — see the docblock. */
  readonly userId: string
  /** The class the operator said it really was. Only with `wrong`. */
  readonly suggestedClass?: string
  /** The instant the notification reported, frozen at mint: where the
   *  recording fallback looks once the track itself is gone. */
  readonly eventAtMs?: number
  /**
   * The subject the notification reported, FROZEN at mint from the row that
   * triggered it. The track may be gone by the time of the tap (a short-lived
   * moving track is deleted within seconds); the recording still the verdict
   * then lands is annotated from this, not from whatever tracks happen to
   * neighbour the instant. The grant lives in the registry (the URL carries
   * only its id), so this adds nothing to the link or to the signed bytes.
   */
  readonly subject?: NcVerdictSubject
  readonly viaLink?: boolean
}

/** The verdict a button records. */
export type NcVerdictValue = 'correct' | 'wrong' | 'wrong-label'

/**
 * What a verdict grant knows about the notified subject. `bbox` is
 * NORMALISED `[0,1]` against the full detection frame — the same space the
 * retrain annotations use, so any still of the camera reads the same numbers.
 */
export interface NcVerdictSubject {
  /** The detector class as notified (`dog`, `person`). */
  readonly className: string
  /** The display label (a recognised name, a plate, a sub-class). */
  readonly label?: string
  readonly bbox?: BboxRect
}

/**
 * What one button is allowed to do, fixed at mint time.
 *
 * A DISCRIMINATED UNION rather than an optional-field bag: the plane switches
 * on `kind` and TypeScript refuses a grant missing what its branch needs, so a
 * fifth button family cannot be added without the plane being made to handle
 * it. The previous shape was "a sequence, always", and a snooze faked as a
 * sequence would have been a sequence the rule does not have.
 */
export type NcActionGrant =
  | NcSequenceGrant
  | NcSnoozeGrant
  | NcAlarmGrant
  | NcAddonUpdateGrant
  | NcServerUpdateGrant
  | NcDetectionVerdictGrant

/** Why a claim did not produce a grant. Each is a DIFFERENT thing to tell a
 *  human standing in front of the page, which is the point of separating them. */
export type NcActionClaimFailure = 'unknown' | 'expired' | 'already-used'

export type NcActionClaim =
  | { readonly ok: true; readonly grant: NcActionGrant }
  | { readonly ok: false; readonly reason: NcActionClaimFailure }

/** Sign `(id, exp)` — the exact string the verifier recomputes. Same shape as
 *  the artifact plane's, deliberately: one signing convention in this addon. */
export function signActionToken(secret: string, id: string, expMs: number): string {
  return createHmac('sha256', secret).update(`act:${id}:${expMs}`).digest('hex')
}

/**
 * Verify a callback's `(id, exp, sig)`.
 *
 * Constant-time on the signature so a public route cannot be probed for it byte
 * by byte, and expiry-checked BEFORE the compare so an expired link is refused
 * even when its signature is perfect.
 */
export function verifyActionSignature(input: {
  readonly secret: string
  readonly id: string
  readonly exp: number
  readonly sig: string
  readonly nowMs: number
}): boolean {
  if (!Number.isFinite(input.exp) || input.exp <= input.nowMs) return false
  const expected = signActionToken(input.secret, input.id, input.exp)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(input.sig, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Build the fully-qualified, signed callback URL for one button. */
export function buildActionUrl(input: {
  readonly baseUrl: string
  readonly routePrefix: string
  readonly id: string
  readonly secret: string
  readonly expMs: number
}): string {
  const sig = signActionToken(input.secret, input.id, input.expMs)
  const base = input.baseUrl.endsWith('/') ? input.baseUrl.slice(0, -1) : input.baseUrl
  const prefix = input.routePrefix.startsWith('/') ? input.routePrefix : `/${input.routePrefix}`
  return `${base}${prefix}/${encodeURIComponent(input.id)}?exp=${input.expMs}&sig=${sig}`
}

/**
 * How long a button stays live.
 *
 * Fifteen minutes, not the artifact plane's 24 h. An image link is a read; this
 * one moves something physical, and the window is the only thing limiting who
 * can use a forwarded notification. An operator who wakes hours later opens the
 * app — the button was never the path for that.
 */
const DEFAULT_ACTION_TTL_MS = 15 * 60_000

/**
 * How long a SNOOZE button stays live: one hour.
 *
 * Longer than a sequence's fifteen minutes because the blast radius is the
 * opposite shape. A sequence moves a gate; a snooze silences, at most, the one
 * person the notification was already addressed to, for a bounded window they
 * can end from the app. The thing an operator actually does with it — waking
 * up to a noisy camera at 03:00 and wanting it quiet — happens on a
 * notification that is not fresh.
 */
const SNOOZE_ACTION_TTL_MS = 60 * 60_000

/** How long a Correct / Wrong button stays live: one day. */
const VERDICT_ACTION_TTL_MS = 24 * 60 * 60_000

/**
 * How long a DISARM button stays live: five minutes.
 *
 * The shortest TTL in this file, and deliberately shorter than the arm one.
 * Disarming is the only button in the system that REMOVES a protection, over a
 * link that travelled through a push relay — so the window in which a
 * forwarded screenshot is worth anything is the walk from the door to the
 * keypad, and nothing longer. Past it the operator opens the app, which is
 * what the app is for.
 */
export const ALARM_DISARM_TTL_MS = 5 * 60_000

/** Just enough of a button to price its window — known before an id exists. */
export type NcActionTtlSubject =
  | { readonly kind: 'sequence' }
  | { readonly kind: 'snooze' }
  | { readonly kind: 'alarm'; readonly action: NcAlarmGrant['action'] }
  | { readonly kind: 'addon-update' }
  | { readonly kind: 'server-update' }
  | { readonly kind: 'detection-verdict' }

/**
 * The TTL a button of this kind gets.
 *
 * ONE place, so a fourth family cannot silently inherit the longest window —
 * which is how a disarm link would end up living as long as a picture link.
 */
export function actionTtlMs(subject: NcActionTtlSubject): number {
  switch (subject.kind) {
    case 'snooze':
      return SNOOZE_ACTION_TTL_MS
    case 'alarm':
      // The Arm anyway lives exactly as long as the refusal it is bound to —
      // past that the panel would refuse it anyway, and a button that is
      // pressable but always says "expired" is the worse of the two.
      if (subject.action === 'arm-anyway') return ARM_ANYWAY_TTL_MS
      // A bypass narrows what ONE arm watches and ends with it; it removes less
      // than a disarm, so it gets the ordinary window, not the disarm's five
      // minutes — the panel still refuses it once that arm is over.
      if (subject.action === 'bypass-input') return DEFAULT_ACTION_TTL_MS
      return subject.action === 'disarm' ? ALARM_DISARM_TTL_MS : DEFAULT_ACTION_TTL_MS
    case 'sequence':
      return DEFAULT_ACTION_TTL_MS
    // Fifteen minutes, the sequence window — NOT the snooze hour. A snooze is
    // longer because at worst it silences the one person the notification was
    // addressed to; this one restarts every addon it names on a whole node,
    // over a link that travelled through a push relay. An operator who reads
    // the notification an hour later opens the app, which is exactly where the
    // notification's own tap target (`/system/addons?node=…`, D305) sends them.
    case 'addon-update':
      return DEFAULT_ACTION_TTL_MS
    // Same fifteen-minute window as the addon-update family. This one reboots
    // a whole node, over a link that travelled through a push relay. An
    // operator who reads the notification an hour later opens the app, which
    // is exactly where the notification's own tap target (`/system/nodes?node=…`,
    // D305) sends them.
    case 'server-update':
      return DEFAULT_ACTION_TTL_MS
    // A day. The blast radius is the smallest in this file (one more
    // retraining mark on a track the recipient was shown, bounded by the
    // staging budget), and the moment it is wanted is when the operator reads
    // the notification, which is routinely hours after it arrived.
    case 'detection-verdict':
      return VERDICT_ACTION_TTL_MS
  }
}

interface StoredGrant {
  readonly grant: NcActionGrant
  used: boolean
}

export class NcActionTokenRegistry {
  private readonly grants = new Map<string, StoredGrant>()
  private readonly now: () => number

  constructor(now?: () => number) {
    this.now = now ?? ((): number => Date.now())
  }

  /** Register a freshly minted grant. The caller owns id generation (it needs
   *  the id to build the URL before the record exists). */
  put(grant: NcActionGrant): void {
    this.grants.set(grant.id, { grant, used: false })
  }

  /**
   * Take the grant, once.
   *
   * Synchronous and mutating in one step ON PURPOSE — see the header. Anything
   * that awaited between the read and the mark would let two taps through, and
   * the thing on the other end is a lock or a gate.
   */
  claim(id: string): NcActionClaim {
    const found = this.grants.get(id)
    if (found === undefined) return { ok: false, reason: 'unknown' }
    if (found.used) return { ok: false, reason: 'already-used' }
    if (found.grant.expiresAt <= this.now()) return { ok: false, reason: 'expired' }
    found.used = true
    return { ok: true, grant: found.grant }
  }

  /**
   * Read the grant without spending it. ONLY the confirm page of a link-only
   * channel may call this: it exists so a link preview that opens the URL
   * cannot spend the token, and it never runs anything.
   */
  peek(id: string): NcActionClaim {
    const found = this.grants.get(id)
    if (found === undefined) return { ok: false, reason: 'unknown' }
    if (found.used) return { ok: false, reason: 'already-used' }
    if (found.grant.expiresAt <= this.now()) return { ok: false, reason: 'expired' }
    return { ok: true, grant: found.grant }
  }

  /** Drop records that can no longer be claimed. Memory hygiene only — an
   *  expired record is already refused by {@link claim}, so a sweep that never
   *  ran would cost bytes, never safety. */
  sweep(): number {
    const now = this.now()
    let removed = 0
    for (const [id, entry] of this.grants) {
      if (entry.used || entry.grant.expiresAt <= now) {
        this.grants.delete(id)
        removed += 1
      }
    }
    return removed
  }

  /** Live (unclaimed, unexpired) token count — for the log line that tells an
   *  operator whether buttons are actually being minted. */
  get liveCount(): number {
    const now = this.now()
    let n = 0
    for (const entry of this.grants.values()) {
      if (!entry.used && entry.grant.expiresAt > now) n += 1
    }
    return n
  }
}
