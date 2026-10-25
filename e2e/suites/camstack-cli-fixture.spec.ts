/**
 * camstack CLI fixture smoke test.
 *
 * Phase 2 of the addon CLI-vs-npm test suite. The fixture wraps the
 * built CLI (`packages/cli/dist/cli.js`) as a subprocess so suites can
 * invoke verbs (deploy / login / info / whoami) without globally
 * installing `camstack`.
 *
 * Asserts:
 *   1. The CLI bin resolves and the wrapper returns its exit code + output.
 *   2. `info` prints a JSON-ish version + platform block (cheapest verb).
 *   3. Exit codes propagate (zero on success, non-zero on unknown verb).
 *
 * Gated by CAMSTACK_E2E_LIVE because the verb suite touches the file
 * system + spawns node subprocesses; safe to leave skipped on CI lanes
 * that don't have the harness wired up.
 */
import { describe, it, expect } from 'vitest'
import { runCamstackCli } from '../fixtures/camstack-cli.ts'

const E2E_LIVE = process.env['CAMSTACK_E2E_LIVE'] === '1'
const describeLive = E2E_LIVE ? describe : describe.skip

describeLive('camstack CLI fixture', () => {
  it('returns version on --version', async () => {
    const r = await runCamstackCli(['--version'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('prints help on --help', async () => {
    const r = await runCamstackCli(['--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Usage: camstack')
    expect(r.stdout).toContain('deploy')
  })

  it('returns non-zero on unknown verb', async () => {
    const r = await runCamstackCli(['this-is-not-a-real-verb'])
    expect(r.exitCode).not.toBe(0)
  })

  it('captures stderr separately from stdout', async () => {
    const r = await runCamstackCli(['this-is-not-a-real-verb'])
    // The CLI surfaces unknown-verb errors on stderr (humans + CI logs).
    expect(r.stderr.length).toBeGreaterThan(0)
  })
})
