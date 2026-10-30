/**
 * The mutation gate (plan §3.7, §3.10; D836).
 *
 * A mutating tool never acts on its first call. The first call (no
 * `confirm_token`) is a DRY RUN: it describes what would happen and returns a
 * one-shot token BOUND to the tool and to the exact arguments. Only a second
 * call carrying that token executes, and only if
 *
 *   - the server was started with `--allow-mutations`,
 *   - the token exists, has not expired, and was issued for this tool,
 *   - the arguments are byte-for-byte the ones the dry run described.
 *
 * A token is consumed the moment it is presented, success or not: a mismatch,
 * an expiry or a failed execution all require a fresh dry run. Every call —
 * refused ones included — is written to the audit sink.
 */
import { createHash, randomBytes } from 'node:crypto'
import { scrubValue } from './scrub.js'

/** How long a dry run stays confirmable. Short on purpose: the world moves. */
export const CONFIRM_TTL_MS: number = 5 * 60_000
/** Outstanding dry runs kept at once; the oldest is dropped beyond this. */
export const MAX_OUTSTANDING_TOKENS = 16

export type AuditPhase = 'dry-run' | 'execute' | 'refused' | 'failed' | 'executed'

export interface AuditRecord {
  readonly at: string
  readonly tool: string
  readonly phase: AuditPhase
  readonly argsDigest: string
  readonly detail: string
  readonly args?: unknown
}

export type AuditSink = (record: AuditRecord) => void

/** Default sink: one JSON line on stderr (stdout belongs to the MCP wire). */
export const stderrAudit: AuditSink = (record) => {
  process.stderr.write(`[camstack-ops:audit] ${JSON.stringify(scrubValue(record))}\n`)
}

/** Key-sorted JSON, so two spellings of the same arguments digest alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function digestArgs(tool: string, args: unknown): string {
  return createHash('sha256')
    .update(`${tool}\n${canonicalJson(args)}`)
    .digest('hex')
}

export type ConfirmDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

interface Outstanding {
  readonly tool: string
  readonly digest: string
  readonly expiresAt: number
}

export interface MutationGateOptions {
  /** `--allow-mutations`. */
  readonly allowMutations: boolean
  readonly audit?: AuditSink
  readonly now?: () => number
  /** Injectable for tests; defaults to 128 random bits. */
  readonly newToken?: () => string
  readonly ttlMs?: number
}

export interface IssuedToken {
  readonly confirmToken: string
  readonly expiresAt: number
}

export const MUTATIONS_DISABLED_REASON =
  'mutations are disabled: start the server with --allow-mutations (the camstack-ops entry in .mcp.json does not set it by default)'

export class MutationGate {
  private readonly outstanding = new Map<string, Outstanding>()
  private readonly audit: AuditSink
  private readonly now: () => number
  private readonly newToken: () => string
  private readonly ttlMs: number

  constructor(private readonly options: MutationGateOptions) {
    this.audit = options.audit ?? stderrAudit
    this.now = options.now ?? Date.now
    this.newToken = options.newToken ?? (() => `cfm_${randomBytes(16).toString('hex')}`)
    this.ttlMs = options.ttlMs ?? CONFIRM_TTL_MS
  }

  get enabled(): boolean {
    return this.options.allowMutations
  }

  record(tool: string, phase: AuditPhase, args: unknown, detail: string): void {
    this.audit({
      at: new Date(this.now()).toISOString(),
      tool,
      phase,
      argsDigest: digestArgs(tool, args),
      detail,
      args,
    })
  }

  /** Issue the token of a dry run. Throws when mutations are disabled. */
  issue(tool: string, args: unknown): IssuedToken {
    if (!this.enabled) throw new Error(MUTATIONS_DISABLED_REASON)
    this.sweep()
    while (this.outstanding.size >= MAX_OUTSTANDING_TOKENS) {
      const oldest = this.outstanding.keys().next()
      if (oldest.done) break
      this.outstanding.delete(oldest.value)
    }
    const confirmToken = this.newToken()
    const expiresAt = this.now() + this.ttlMs
    this.outstanding.set(confirmToken, { tool, digest: digestArgs(tool, args), expiresAt })
    return { confirmToken, expiresAt }
  }

  /** Check and CONSUME a presented token. */
  confirm(tool: string, args: unknown, token: string): ConfirmDecision {
    if (!this.enabled) return { ok: false, reason: MUTATIONS_DISABLED_REASON }
    const found = this.outstanding.get(token)
    this.outstanding.delete(token)
    if (!found) {
      return {
        ok: false,
        reason:
          'confirm_token is unknown, already used, or from another session — call the tool again without it for a fresh dry run',
      }
    }
    if (found.expiresAt <= this.now()) {
      return {
        ok: false,
        reason: 'confirm_token expired — call the tool again for a fresh dry run',
      }
    }
    if (found.tool !== tool) {
      return { ok: false, reason: `confirm_token was issued for ${found.tool}, not ${tool}` }
    }
    if (found.digest !== digestArgs(tool, args)) {
      return {
        ok: false,
        reason:
          'the arguments differ from the dry run this confirm_token was issued for — token burned; call the tool again for a fresh dry run',
      }
    }
    return { ok: true }
  }

  private sweep(): void {
    const t = this.now()
    for (const [token, entry] of this.outstanding) {
      if (entry.expiresAt <= t) this.outstanding.delete(token)
    }
  }
}

export interface DryRunOutcome {
  /** What would happen. Shown to the operator. */
  readonly describe: unknown
  /** False when there is nothing to confirm (the preflight refused). */
  readonly confirmable: boolean
}

export interface GatedToolSpec<A> {
  readonly tool: string
  /** Read-only. Must never call the mutating method. */
  readonly dryRun: (args: A) => Promise<DryRunOutcome>
  /** The one place the mutation happens. */
  readonly execute: (args: A) => Promise<unknown>
}

export type GatedResult =
  | { readonly status: 'refused'; readonly reason: string }
  | {
      readonly status: 'dry-run'
      readonly confirm_token?: string
      readonly expiresAt?: string
      readonly dryRun: unknown
      readonly next: string
    }
  | { readonly status: 'executed'; readonly result: unknown }

/**
 * Drive one gated call: dry run without a token, execute with a valid one.
 * `args` excludes `confirm_token`; the token is passed beside it.
 */
export async function runGated<A>(
  gate: MutationGate,
  spec: GatedToolSpec<A>,
  args: A,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  const { tool } = spec
  if (!gate.enabled) {
    gate.record(tool, 'refused', args, 'mutations disabled')
    return { status: 'refused', reason: MUTATIONS_DISABLED_REASON }
  }
  if (confirmToken === undefined) {
    const outcome = await spec.dryRun(args)
    if (!outcome.confirmable) {
      gate.record(tool, 'dry-run', args, 'not confirmable (preflight refused)')
      return {
        status: 'dry-run',
        dryRun: outcome.describe,
        next: 'Nothing to confirm: the preflight refused this plan. Fix what it names and dry-run again.',
      }
    }
    const issued = gate.issue(tool, args)
    gate.record(tool, 'dry-run', args, 'token issued')
    return {
      status: 'dry-run',
      confirm_token: issued.confirmToken,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      dryRun: outcome.describe,
      next: `Nothing was changed. To execute, call ${tool} again with the SAME arguments and confirm_token. The token is single-use and expires.`,
    }
  }
  const decision = gate.confirm(tool, args, confirmToken)
  if (!decision.ok) {
    gate.record(tool, 'refused', args, decision.reason)
    return { status: 'refused', reason: decision.reason }
  }
  gate.record(tool, 'execute', args, 'confirmed — executing')
  try {
    const result = await spec.execute(args)
    gate.record(tool, 'executed', args, 'ok')
    return { status: 'executed', result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    gate.record(tool, 'failed', args, message)
    throw err
  }
}
