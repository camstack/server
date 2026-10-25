/**
 * The bulk revoke of a Tokens & sessions table — the ONLY way more than one
 * credential is revoked at once (D819).
 *
 * It replaced a "Revoke all never used" button that revoked every share link
 * on the hub (2026-10-09). The rules, in order:
 *
 *  1. **The operator selects rows.** Filters and "select all shown" help pick;
 *     nothing here evaluates a predicate of its own.
 *  2. **The preview is exact.** The confirmation names the count, breaks it
 *     down by status ("3 active, 137 expired") and lists the first rows.
 *  3. **Typed confirmation.** The operator types the number. A reflexive
 *     Enter on a pre-filled box cannot revoke anything.
 *  4. **One server call with the exact ids** (`auth.revokeCredentials`) and the
 *     typed count — the hub finds each id in its own store (no kind is
 *     named), refuses a mismatch, skips the caller's own session, and audits
 *     the call.
 */
import { trpc, usePrompt } from '@camstack/ui-library'
import { useState } from 'react'

import i18n from '../../i18n/index'
import { statusLabel } from './credential-columns'
import type { CredentialRow, CredentialStatus } from './credential-row'

/** A noun is an i18n key with `_one` / `_other` forms (`access.nouns.*`). */
export interface BulkNoun {
  readonly key: string
}

export interface BulkRevokeOutcome {
  readonly tone: 'success' | 'danger'
  readonly message: string
}

const PREVIEW_ROWS = 6

const SKIP_REASON_KEY: Readonly<Record<string, string>> = {
  'current-session': 'access.bulk.skipCurrentSession',
  'not-active': 'access.bulk.skipNotActive',
}

function skipReasonText(reason: string): string {
  const key = SKIP_REASON_KEY[reason]
  return key === undefined ? reason : i18n.t(key)
}

/** The bare noun for a count ("share link" / "share links"). */
export function nounFor(count: number, noun: BulkNoun): string {
  return i18n.t(noun.key, { count })
}

export function countLabel(n: number, noun: BulkNoun): string {
  return i18n.t('access.bulk.countOf', { count: n, noun: nounFor(n, noun) })
}

/** "3 active, 137 expired" — the breakdown that makes a wrong selection obvious. */
export function statusBreakdown(rows: readonly CredentialRow[]): string {
  const counts = new Map<CredentialStatus, number>()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  return [...counts.entries()]
    .map(([status, n]) =>
      i18n.t('access.bulk.statusCount', { count: n, status: statusLabel(status).toLowerCase() }),
    )
    .join(', ')
}

/** The confirmation body: what, how many, which. Pure, so a spec can read it. */
export function bulkPreviewMessage(rows: readonly CredentialRow[], noun: BulkNoun): string {
  const shown = rows.slice(0, PREVIEW_ROWS).map((r) => `• ${r.name} — ${r.ownerName}`)
  const more =
    rows.length > PREVIEW_ROWS
      ? [i18n.t('access.bulk.previewMore', { count: rows.length - PREVIEW_ROWS })]
      : []
  return [
    i18n.t('access.bulk.previewIntro', {
      what: countLabel(rows.length, noun),
      breakdown: statusBreakdown(rows),
    }),
    '',
    ...shown,
    ...more,
  ].join('\n')
}

type PromptFn = ReturnType<typeof usePrompt>

/** The typed-count confirmation every bulk revoke asks first (D819, rule 3). */
export async function confirmBulkRevoke(
  prompt: PromptFn,
  rows: readonly CredentialRow[],
  noun: BulkNoun,
): Promise<boolean> {
  const expected = String(rows.length)
  const typed = await prompt({
    title: i18n.t('access.bulk.confirmTitle', { what: countLabel(rows.length, noun) }),
    message: bulkPreviewMessage(rows, noun),
    label: i18n.t('access.bulk.confirmLabel', { expected }),
    placeholder: expected,
    confirmLabel: i18n.t('access.bulk.confirmButton', { expected }),
    variant: 'danger',
    validate: (value) =>
      value.trim() === expected
        ? null
        : i18n.t('access.bulk.confirmMismatch', { expected, noun: nounFor(2, noun) }),
  })
  return typed !== null && typed.trim() === expected
}

export interface BulkRevoke {
  readonly run: (rows: readonly CredentialRow[]) => Promise<boolean>
  readonly busy: boolean
  readonly outcome: BulkRevokeOutcome | null
  readonly dismiss: () => void
}

export function useBulkRevoke(noun: BulkNoun, onDone: () => void): BulkRevoke {
  const prompt = usePrompt()
  const mutation = trpc.auth.revokeCredentials.useMutation()
  const [outcome, setOutcome] = useState<BulkRevokeOutcome | null>(null)

  const run = async (rows: readonly CredentialRow[]): Promise<boolean> => {
    if (rows.length === 0) return false
    if (!(await confirmBulkRevoke(prompt, rows, noun))) return false
    setOutcome(null)
    try {
      const result = await mutation.mutateAsync({
        ids: rows.map((r) => r.id),
        confirmCount: rows.length,
      })
      const skipped = result.skipped.map((s: { id: string; reason: string }) =>
        skipReasonText(s.reason),
      )
      setOutcome({
        tone: 'success',
        message:
          skipped.length > 0
            ? i18n.t('access.bulk.revokedSkipped', {
                what: countLabel(result.revoked.length, noun),
                count: skipped.length,
                reasons: [...new Set(skipped)].join(', '),
              })
            : i18n.t('access.bulk.revoked', { what: countLabel(result.revoked.length, noun) }),
      })
      return true
    } catch (err: unknown) {
      setOutcome({
        tone: 'danger',
        message: i18n.t('access.bulk.revokeFailed', {
          error: err instanceof Error ? err.message : i18n.t('access.bulk.requestFailed'),
        }),
      })
      return false
    } finally {
      onDone()
    }
  }

  return {
    run,
    busy: mutation.isPending,
    outcome,
    dismiss: () => setOutcome(null),
  }
}

/**
 * Bulk revoke for a kind with no bulk endpoint: the same typed confirmation,
 * then the kind's existing per-item revoke once per selected row. A row that
 * fails does not stop the others; the outcome names how many failed and why.
 */
export function useEachBulkRevoke(
  noun: BulkNoun,
  revokeOne: (id: string) => Promise<unknown>,
  onDone: () => void,
): BulkRevoke {
  const prompt = usePrompt()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<BulkRevokeOutcome | null>(null)

  const run = async (rows: readonly CredentialRow[]): Promise<boolean> => {
    if (rows.length === 0) return false
    if (!(await confirmBulkRevoke(prompt, rows, noun))) return false
    setOutcome(null)
    setBusy(true)
    const failures: string[] = []
    let revoked = 0
    for (const row of rows) {
      try {
        await revokeOne(row.id)
        revoked += 1
      } catch (err: unknown) {
        failures.push(
          `${row.name}: ${err instanceof Error ? err.message : i18n.t('access.bulk.requestFailed')}`,
        )
      }
    }
    setBusy(false)
    onDone()
    if (failures.length === 0) {
      setOutcome({
        tone: 'success',
        message: i18n.t('access.bulk.revoked', { what: countLabel(revoked, noun) }),
      })
      return true
    }
    setOutcome({
      tone: 'danger',
      message: i18n.t(
        failures.length > 3 ? 'access.bulk.eachPartialMore' : 'access.bulk.eachPartial',
        {
          what: countLabel(revoked, noun),
          count: failures.length,
          details: failures.slice(0, 3).join('; '),
        },
      ),
    })
    return revoked > 0
  }

  return { run, busy, outcome, dismiss: () => setOutcome(null) }
}
