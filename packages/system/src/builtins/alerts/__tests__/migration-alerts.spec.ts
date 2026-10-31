import type { Alert, MigrationLedgerEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MIGRATION_ALERT_PREFIX, planMigrationAlerts } from '../migration-alerts.js'

function entry(id: string, patch: Partial<MigrationLedgerEntry>): MigrationLedgerEntry {
  return {
    id,
    database: 'settings',
    owner: 'hub',
    level: 'hub-store',
    seq: 1,
    status: 'applied',
    attempts: 1,
    appliedAt: 1,
    codeVersion: '1.0.0',
    planSummary: null,
    progress: null,
    error: null,
    reason: null,
    nodeId: null,
    bootId: 'b',
    ...patch,
  }
}

const NOW = 1_000

describe('planMigrationAlerts', () => {
  it('raises a critical alert with a retry action for a failed migration', () => {
    const plan = planMigrationAlerts(
      [entry('hub/2026-10-31-a', { status: 'failed', error: 'boom' })],
      [],
      NOW,
    )
    expect(plan.raise).toHaveLength(1)
    const [alert] = plan.raise
    expect(alert?.id).toBe(`${MIGRATION_ALERT_PREFIX}hub/2026-10-31-a`)
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('boom')
    expect(alert?.action?.invoke).toEqual({
      addonId: 'sqlite-settings',
      action: 'retryMigration',
      input: { id: 'hub/2026-10-31-a' },
    })
  })

  it('raises critical for a snapshot-refused block, warning for skipped-newer, nothing for applied or dependency-blocked', () => {
    const plan = planMigrationAlerts(
      [
        entry('hub/a', { status: 'blocked', reason: 'snapshot-refused' }),
        entry('hub/b', { status: 'skipped-newer' }),
        entry('hub/c', { status: 'applied' }),
        entry('hub/d', { status: 'blocked', reason: 'dependency-failed:hub/x' }),
      ],
      [],
      NOW,
    )
    expect(plan.raise.map((a) => [a.id.slice(MIGRATION_ALERT_PREFIX.length), a.severity])).toEqual([
      ['hub/a', 'critical'],
      ['hub/b', 'warning'],
    ])
  })

  it('dismisses an active migration alert whose id the ledger no longer faults', () => {
    const open: Pick<Alert, 'id' | 'status'>[] = [
      { id: `${MIGRATION_ALERT_PREFIX}hub/gone`, status: 'active' },
      { id: `${MIGRATION_ALERT_PREFIX}hub/still`, status: 'active' },
      { id: 'something-else', status: 'active' },
    ]
    const plan = planMigrationAlerts(
      [entry('hub/still', { status: 'failed', error: 'e' })],
      open,
      NOW,
    )
    expect(plan.dismiss).toEqual([`${MIGRATION_ALERT_PREFIX}hub/gone`])
  })
})
