import { userError } from '@camstack/types'
/**
 * CliApprovalService — the browser-approval login of a terminal client
 * (`camstack login`, the MCP `setup_login`), in the shape of RFC 8628.
 *
 * Flow: the CLI calls `begin` (public, rate limited) and gets a short user
 * code to show the operator and a long device secret it keeps. The operator
 * opens `/approve` in an already signed-in admin UI, types the code, sees who
 * asked (ip, client) and approves or denies. The CLI polls with its secret;
 * the first poll after an approval hands the approving user id to the router,
 * which mints a normal session through the single session mint.
 *
 * Design mirrors {@link HandoffCodeService}:
 *   - the device secret and the user code are kept ONLY as SHA-256 hashes;
 *   - TTL 5 min, single use (an approved entry is consumed by the poll that
 *     collects it, an expired or denied one by the poll that reports it);
 *   - in-memory and bounded (global and per requesting ip).
 */
import * as crypto from 'node:crypto'

/** Wire prefix of the device secret (`cda_` = CamStack Device Approval; redeemable once for a session). */
export const CLI_APPROVAL_SECRET_PREFIX = 'cda_'
export const CLI_APPROVAL_TTL_MS = 5 * 60_000
export const CLI_APPROVAL_INTERVAL_SEC = 3
/** Added to the poll interval each time a client polls faster than allowed. */
export const CLI_APPROVAL_SLOW_DOWN_SEC = 2
export const CLI_APPROVAL_MAX_PENDING = 200
export const CLI_APPROVAL_MAX_PENDING_PER_IP = 5
/** Requests with no known address share one bucket, so "unknown" is never uncapped. */
const UNKNOWN_IP_BUCKET = '(unknown)'

/** Crockford base32: no I, L, O, U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const USER_CODE_LENGTH = 8

export interface CliApprovalRequester {
  readonly ip?: string
  /** The label the CLIENT chose for itself — unverified, display only with that caveat. */
  readonly client?: string
  /** The User-Agent the hub observed on the request. */
  readonly userAgent?: string
}

export interface CliApprovalBeginResult {
  /** `ABCD-EFGH`, shown to the operator. */
  readonly userCode: string
  /** The raw device secret — returned exactly once, never stored. */
  readonly deviceSecret: string
  readonly expiresAt: number
  readonly intervalSec: number
}

/** What the approving operator sees of a request. */
export interface CliApprovalRequestView {
  /** Opaque id for listing and denying; never enough to approve. */
  readonly requestId: string
  readonly ip: string | null
  /** Self-reported by the client: unverified. */
  readonly client: string | null
  /** Observed by the hub on the request. */
  readonly userAgent: string | null
  readonly createdAt: number
  readonly expiresAt: number
}

export type CliApprovalPollResult =
  | { readonly status: 'pending'; readonly intervalSec: number }
  | { readonly status: 'slow_down'; readonly intervalSec: number }
  | {
      readonly status: 'approved'
      readonly userId: string
      readonly requestId: string
      /** Who asked, as recorded at `begin` — for the session row. */
      readonly requester: CliApprovalRequester
    }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' }
  | { readonly status: 'unknown' }

export type CliApprovalDecision = 'ok' | 'unknown' | 'expired' | 'already-decided'

type EntryState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'approved'; readonly userId: string }
  | { readonly kind: 'denied' }

interface Entry {
  readonly requestId: string
  readonly userCodeHash: string
  readonly ip: string | null
  readonly client: string | null
  readonly userAgent: string | null
  readonly createdAt: number
  readonly expiresAt: number
  state: EntryState
  intervalSec: number
  lastPollAt: number | null
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** Uppercase, drop separators and spaces, fold Crockford's look-alikes (I/L→1, O→0). */
export function normalizeUserCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function randomUserCode(): string {
  let out = ''
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) out += CROCKFORD[crypto.randomInt(CROCKFORD.length)]
  return out
}

export class CliApprovalService {
  /** Keyed by SHA-256(device secret). */
  private readonly bySecret = new Map<string, Entry>()
  /** SHA-256(normalized user code) → SHA-256(device secret). */
  private readonly byCode = new Map<string, string>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = CLI_APPROVAL_TTL_MS,
  ) {}

  begin(requester: CliApprovalRequester = {}): CliApprovalBeginResult {
    this.prune()
    const ip = requester.ip ?? null
    const bucket = ip ?? UNKNOWN_IP_BUCKET
    if (this.countFor(bucket) >= CLI_APPROVAL_MAX_PENDING_PER_IP) {
      throw userError(
        'server.cli-approval-busy',
        undefined,
        'Too many pending sign-in requests from this address',
      )
    }
    // The global bound is soft: a full table drops the oldest request of the
    // busiest address, so a flood from many addresses cannot lock everyone out.
    while (this.bySecret.size >= CLI_APPROVAL_MAX_PENDING) this.evictOne()
    let code = randomUserCode()
    while (this.byCode.has(sha256(code))) code = randomUserCode()
    const deviceSecret = `${CLI_APPROVAL_SECRET_PREFIX}${crypto.randomBytes(32).toString('hex')}`
    const createdAt = this.now()
    const expiresAt = createdAt + this.ttlMs
    const secretHash = sha256(deviceSecret)
    const userCodeHash = sha256(code)
    this.bySecret.set(secretHash, {
      requestId: crypto.randomBytes(8).toString('hex'),
      userCodeHash,
      ip,
      client: requester.client ?? null,
      userAgent: requester.userAgent ?? null,
      createdAt,
      expiresAt,
      state: { kind: 'pending' },
      intervalSec: CLI_APPROVAL_INTERVAL_SEC,
      lastPollAt: null,
    })
    this.byCode.set(userCodeHash, secretHash)
    return {
      userCode: formatUserCode(code),
      deviceSecret,
      expiresAt,
      intervalSec: CLI_APPROVAL_INTERVAL_SEC,
    }
  }

  /** The request behind a typed user code, or null (unknown or expired). */
  describe(userCode: string): CliApprovalRequestView | null {
    const entry = this.entryOfCode(userCode)
    if (entry === null || entry.state.kind !== 'pending') return null
    return this.viewOf(entry)
  }

  /** Requests still waiting for a decision (no code: it is never enough to approve from a list). */
  listPending(): readonly CliApprovalRequestView[] {
    this.prune()
    const out: CliApprovalRequestView[] = []
    for (const entry of this.bySecret.values()) {
      if (entry.state.kind === 'pending') out.push(this.viewOf(entry))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** The pending request behind an id a list showed, or null. */
  describeById(requestId: string): CliApprovalRequestView | null {
    const entry = [...this.bySecret.values()].find((e) => e.requestId === requestId)
    return entry === undefined || entry.state.kind !== 'pending' || this.now() > entry.expiresAt
      ? null
      : this.viewOf(entry)
  }

  approve(userCode: string, userId: string): CliApprovalDecision {
    return this.decide(this.entryOfCode(userCode), { kind: 'approved', userId })
  }

  deny(ref: { readonly userCode: string } | { readonly requestId: string }): CliApprovalDecision {
    const entry =
      'userCode' in ref
        ? this.entryOfCode(ref.userCode)
        : ([...this.bySecret.values()].find((e) => e.requestId === ref.requestId) ?? null)
    return this.decide(entry, { kind: 'denied' })
  }

  /** The device's poll. A terminal answer (approved, denied, expired) consumes the entry. */
  poll(deviceSecret: string): CliApprovalPollResult {
    const key = sha256(deviceSecret)
    const entry = this.bySecret.get(key)
    if (!entry) return { status: 'unknown' }
    const now = this.now()
    if (now > entry.expiresAt) {
      this.remove(key, entry)
      return { status: 'expired' }
    }
    if (entry.state.kind === 'approved') {
      this.remove(key, entry)
      return {
        status: 'approved',
        userId: entry.state.userId,
        requestId: entry.requestId,
        requester: {
          ...(entry.ip !== null ? { ip: entry.ip } : {}),
          ...(entry.client !== null ? { client: entry.client } : {}),
          ...(entry.userAgent !== null ? { userAgent: entry.userAgent } : {}),
        },
      }
    }
    if (entry.state.kind === 'denied') {
      this.remove(key, entry)
      return { status: 'denied' }
    }
    const tooSoon = entry.lastPollAt !== null && now - entry.lastPollAt < entry.intervalSec * 1000
    entry.lastPollAt = now
    if (tooSoon) {
      entry.intervalSec += CLI_APPROVAL_SLOW_DOWN_SEC
      return { status: 'slow_down', intervalSec: entry.intervalSec }
    }
    return { status: 'pending', intervalSec: entry.intervalSec }
  }

  get pendingCount(): number {
    return this.bySecret.size
  }

  private decide(entry: Entry | null, next: EntryState): CliApprovalDecision {
    if (entry === null) return 'unknown'
    if (this.now() > entry.expiresAt) return 'expired'
    if (entry.state.kind !== 'pending') return 'already-decided'
    entry.state = next
    return 'ok'
  }

  private entryOfCode(userCode: string): Entry | null {
    const secretHash = this.byCode.get(sha256(normalizeUserCode(userCode)))
    if (secretHash === undefined) return null
    const entry = this.bySecret.get(secretHash)
    if (!entry || this.now() > entry.expiresAt) return null
    return entry
  }

  private viewOf(entry: Entry): CliApprovalRequestView {
    return {
      requestId: entry.requestId,
      ip: entry.ip,
      client: entry.client,
      userAgent: entry.userAgent,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }
  }

  private countFor(bucket: string): number {
    let n = 0
    for (const entry of this.bySecret.values())
      if ((entry.ip ?? UNKNOWN_IP_BUCKET) === bucket) n += 1
    return n
  }

  /** Drop the oldest entry of the address holding the most entries. */
  private evictOne(): void {
    const counts = new Map<string, number>()
    for (const entry of this.bySecret.values()) {
      const bucket = entry.ip ?? UNKNOWN_IP_BUCKET
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    let busiest = UNKNOWN_IP_BUCKET
    let most = -1
    for (const [bucket, n] of counts) {
      if (n > most) {
        busiest = bucket
        most = n
      }
    }
    for (const [key, entry] of this.bySecret) {
      if ((entry.ip ?? UNKNOWN_IP_BUCKET) === busiest) {
        this.remove(key, entry)
        return
      }
    }
  }

  private remove(key: string, entry: Entry): void {
    this.bySecret.delete(key)
    this.byCode.delete(entry.userCodeHash)
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.bySecret) {
      if (now > entry.expiresAt) this.remove(key, entry)
    }
  }
}
