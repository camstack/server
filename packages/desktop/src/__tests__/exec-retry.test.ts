/**
 * `exec-retry.mjs` — the bounded-retry + failure-description helpers used by
 * `stage-deps.mjs` for the one long, network-heavy, externally-killable step
 * (the `npm install @camstack/server@<version>` closure install).
 *
 * Regression guard for the v1.2.104 linux release leg: the closure install was
 * terminated by an EXTERNAL SIGTERM 124 s in (npm's own arborist signal handler
 * caught it and exited 1), the whole desktop leg failed, and `publish-release`
 * was skipped — leaving the GitHub Release stuck as a draft. Two things were
 * wrong: one transient kill cost the entire release, and the `execSync` throw
 * surfaced only a node stack with `stderr: null` — no line saying WHAT failed.
 */
import { describe, expect, it, vi } from 'vitest'
import { describeExecFailure, runWithRetry } from '../../scripts/exec-retry.mjs'

describe('runWithRetry', () => {
  it('runs the attempt once when it succeeds', () => {
    const attempt = vi.fn()
    const sleep = vi.fn()

    runWithRetry(attempt, { attempts: 3, delayMs: 10, sleep })

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries after a failure and stops as soon as an attempt succeeds', () => {
    const failure = new Error('boom')
    const attempt = vi.fn().mockImplementationOnce(() => {
      throw failure
    })
    const onRetry = vi.fn()
    const sleep = vi.fn()

    runWithRetry(attempt, { attempts: 3, delayMs: 5000, onRetry, sleep })

    expect(attempt).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, attempts: 3, error: failure })
    expect(sleep).toHaveBeenCalledWith(5000)
  })

  it('rethrows the LAST error once the bound is exhausted', () => {
    const first = new Error('first')
    const last = new Error('last')
    const attempt = vi
      .fn()
      .mockImplementationOnce(() => {
        throw first
      })
      .mockImplementationOnce(() => {
        throw last
      })

    expect(() => runWithRetry(attempt, { attempts: 2, delayMs: 1, sleep: vi.fn() })).toThrow(last)
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('never retries when the bound is a single attempt', () => {
    const attempt = vi.fn().mockImplementation(() => {
      throw new Error('boom')
    })
    const onRetry = vi.fn()

    expect(() =>
      runWithRetry(attempt, { attempts: 1, delayMs: 1, onRetry, sleep: vi.fn() }),
    ).toThrow('boom')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe('describeExecFailure', () => {
  it('names the exit status — the shape an externally-killed npm produces', () => {
    // execSync surfaces npm's own exit code; npm had already caught the SIGTERM
    // itself, so the parent sees `status: 1, signal: null, stderr: null`.
    const err = Object.assign(new Error('Command failed: npm install'), {
      status: 1,
      signal: null,
      stderr: null,
    })

    expect(describeExecFailure(err, 'npm install @camstack/server@1.2.104')).toBe(
      'npm install @camstack/server@1.2.104 — exited with status 1',
    )
  })

  it('names the signal when the child itself was terminated', () => {
    const err = Object.assign(new Error('Command failed'), { status: null, signal: 'SIGTERM' })

    expect(describeExecFailure(err, 'curl')).toBe('curl — terminated by SIGTERM')
  })

  it('falls back to the error message when neither status nor signal is present', () => {
    expect(describeExecFailure(new Error('spawn ENOENT'), 'tar')).toBe('tar — spawn ENOENT')
  })

  it('describes a non-Error rejection without throwing', () => {
    expect(describeExecFailure('nope', 'tar')).toBe('tar — nope')
  })
})
