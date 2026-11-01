import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FailedRunnerRetryLedger, readRunnerPackageVersions } from '../failed-runner-retry.js'

describe('FailedRunnerRetryLedger (#346)', () => {
  it('retries a failed runner exactly once after its package version changed', () => {
    const ledger = new FailedRunnerRetryLedger()
    ledger.recordTrip('ml', { '/a/ml': '1.0.0' })
    const first = ledger.decide('ml', { '/a/ml': '2.0.0' })
    expect(first.retry).toBe(true)
    // the same new version again: the snapshot is consumed, no second retry
    expect(ledger.decide('ml', { '/a/ml': '2.0.0' })).toEqual({
      retry: false,
      reason: 'no-trip-recorded',
    })
  })

  it('does not retry when the version is unchanged, and keeps waiting for a change', () => {
    const ledger = new FailedRunnerRetryLedger()
    ledger.recordTrip('ml', { '/a/ml': '1.0.0' })
    expect(ledger.decide('ml', { '/a/ml': '1.0.0' })).toEqual({
      retry: false,
      reason: 'version-unchanged',
    })
    expect(ledger.decide('ml', { '/a/ml': '1.0.0' }).retry).toBe(false)
    expect(ledger.decide('ml', { '/a/ml': '1.0.1' }).retry).toBe(true)
  })

  it('an unreadable current version is not a change', () => {
    const ledger = new FailedRunnerRetryLedger()
    ledger.recordTrip('ml', { '/a/ml': '1.0.0' })
    expect(ledger.decide('ml', { '/a/ml': null }).retry).toBe(false)
  })

  it('a second trip needs a further version change', () => {
    const ledger = new FailedRunnerRetryLedger()
    ledger.recordTrip('ml', { '/a/ml': '1.0.0' })
    expect(ledger.decide('ml', { '/a/ml': '2.0.0' }).retry).toBe(true)
    ledger.recordTrip('ml', { '/a/ml': '2.0.0' })
    expect(ledger.decide('ml', { '/a/ml': '2.0.0' }).retry).toBe(false)
  })

  it('reads package versions from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frr-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '3.4.5' }))
    expect(readRunnerPackageVersions([dir, '/nonexistent'])).toEqual({
      [dir]: '3.4.5',
      '/nonexistent': null,
    })
  })
})
