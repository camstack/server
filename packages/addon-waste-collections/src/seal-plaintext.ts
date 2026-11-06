/**
 * A credential an older version stored as plain text in a `waste-source` record is moved into the
 * keychain BEFORE the kind that names it secret is declared (planning#440 step 6).
 *
 * Why before: the real kind shows every set credential as the redaction token, and a declaration
 * can add secret fields but never drop them. Declared early, a text that could not be sealed is
 * hidden for good. So each boot: stay on the plain declaration, read the text, put each value in
 * the keychain under the ref the real kind will expect, patch the record with the marker, read
 * both back; only when every record is sealed (or none held a credential) does the caller declare
 * the real kind. A failure rolls the records back and keeps the plain declaration for this boot;
 * the next boot tries again. Once the real kind is declared the plain declaration is refused,
 * which is the expected no-op.
 */
import {
  asRecordsError,
  DeclarationRefusedError,
  makeSecretMarker,
  type RecordsAccess,
  recordSecretRef,
  type SecretsAccess,
} from '@camstack/types'
import { isSecretArg } from './waste-secrets.js'
import { plainWasteSourceKind, WASTE_COLLECTIONS_OWNER } from './waste-source-record-kinds.js'

export interface SealFailure {
  readonly id: string
  readonly reason: string
}

export type SealOutcome =
  /** The real kind is already declared: nothing can be plain text any more. */
  | { readonly state: 'already-secret' }
  /** Every record is sealed (or none had a credential): the real kind may be declared. */
  | { readonly state: 'sealed'; readonly sealed: number }
  /** Stay on the plain declaration for this boot. */
  | { readonly state: 'failed'; readonly failures: readonly SealFailure[] }

export interface SealLog {
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  error(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

interface Plan {
  readonly id: string
  /** key -> text, as stored. */
  readonly text: Readonly<Record<string, string>>
  /** key -> ref in the keychain. */
  readonly refs: Readonly<Record<string, string>>
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function sealPlaintextCredentials(
  records: Pick<RecordsAccess, 'declare' | 'kind'>,
  secrets: SecretsAccess | undefined,
  log: SealLog,
): Promise<SealOutcome> {
  try {
    await records.declare({ 'waste-source': plainWasteSourceKind })
  } catch (err: unknown) {
    // Judged by its code, not its class: in a grouped runner the records door is the host's, and
    // its error class is not the one bundled here.
    if (asRecordsError(err) instanceof DeclarationRefusedError) {
      log.info(
        'waste-collections: the secret kind is already declared; no plain-text credential can remain',
      )
      return { state: 'already-secret' }
    }
    log.error('waste-collections: the plain waste-source kind could not be declared', {
      meta: { error: reasonOf(err) },
    })
    throw err
  }
  const handle = records.kind(plainWasteSourceKind)
  const plans: Plan[] = []
  const page = await handle.query({ limit: 1000 })
  for (const record of page.records) {
    const text: Record<string, string> = {}
    const refs: Record<string, string> = {}
    for (const [key, value] of Object.entries(record.data.args)) {
      if (isSecretArg(key) && typeof value === 'string' && value.length > 0) {
        text[key] = value
        refs[key] = recordSecretRef(
          WASTE_COLLECTIONS_OWNER,
          plainWasteSourceKind.name,
          record.id,
          `args.${key}`,
        )
      }
    }
    if (Object.keys(text).length > 0) plans.push({ id: record.id, text, refs })
  }
  if (plans.length === 0) return { state: 'sealed', sealed: 0 }
  if (secrets === undefined) {
    const failures = plans.map((p) => ({ id: p.id, reason: 'this process has no keychain door' }))
    return reportFailed(log, failures)
  }

  // Phase 1: every value into the keychain, read back. Records are untouched until all landed.
  const stored: string[] = []
  const failures: SealFailure[] = []
  for (const plan of plans) {
    try {
      for (const [key, ref] of Object.entries(plan.refs)) {
        await secrets.put(ref, plan.text[key] ?? '')
        stored.push(ref)
      }
      const back = await secrets.resolve(Object.values(plan.refs))
      for (const [key, ref] of Object.entries(plan.refs)) {
        const entry = back[ref]
        if (entry?.kind !== 'value' || entry.value !== plan.text[key]) {
          throw new Error(`the keychain did not return the value stored for ${key}`)
        }
      }
    } catch (err: unknown) {
      failures.push({ id: plan.id, reason: reasonOf(err) })
    }
  }
  if (failures.length > 0) {
    await secrets.delete(stored).catch(() => 0)
    return reportFailed(log, failures)
  }

  // Phase 2: the records carry the markers. A failure puts the text back, so the plain boot is whole.
  const patched: Plan[] = []
  try {
    for (const plan of plans) {
      const markers = Object.fromEntries(
        Object.entries(plan.refs).map(([key, ref]) => [key, makeSecretMarker(ref)]),
      )
      await handle.patch(plan.id, { args: markers })
      patched.push(plan)
    }
  } catch (err: unknown) {
    const failed = plans[patched.length]
    for (const plan of patched)
      await handle.patch(plan.id, { args: plan.text }).catch(() => undefined)
    await secrets.delete(stored).catch(() => 0)
    return reportFailed(log, [{ id: failed?.id ?? '(unknown)', reason: reasonOf(err) }])
  }
  log.info('waste-collections: plain-text credentials moved into the keychain', {
    meta: { records: plans.length },
  })
  return { state: 'sealed', sealed: plans.length }
}

function reportFailed(log: SealLog, failures: readonly SealFailure[]): SealOutcome {
  log.error(
    'waste-collections: credentials stored as plain text could not be moved into the keychain; records stay as they were this boot and it is tried again on the next',
    { meta: { failures } },
  )
  return { state: 'failed', failures }
}
