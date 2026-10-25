import { describe, expect, it } from 'vitest'
import { detectWrapperIdentity, type WrapperIdentityInputs } from '../wrapper-identity.js'

/**
 * The rule under test (D437): observe what you can, declare only what you
 * cannot — and never let the declaration be the only source.
 *
 * The 2026-08-02 case is the reason. `check-deployment-templates.ts` proved
 * every day that the templates DECLARED `ghcr.io/camstack/camstack:intel-latest`
 * while the hub actually ran `camstack-server:intel-1.1.74` from a renamed
 * repository nothing rebuilt. A `CAMSTACK_WRAPPER=docker` env would be exactly
 * that same declaration, so `kind` may never come from one.
 */

const LINUX_CONTAINER_CGROUP =
  '0::/system.slice/docker-9f2c1b7d5e4a.scope\n11:memory:/docker/9f2c1b7d5e4a\n'
const LINUX_HOST_CGROUP = '0::/user.slice/user-1000.slice/session-3.scope\n'

function inputs(overrides: Partial<WrapperIdentityInputs>): WrapperIdentityInputs {
  return {
    platform: 'linux',
    dockerEnvFileExists: false,
    proc1Cgroup: LINUX_HOST_CGROUP,
    electronAppVersion: undefined,
    seedVersion: null,
    ...overrides,
  }
}

function evidenceFor(identity: ReturnType<typeof detectWrapperIdentity>, fact: string) {
  const row = identity.evidence.find((entry) => entry.fact === fact)
  if (row === undefined) throw new Error(`no evidence row for ${fact}`)
  return row
}

describe('detectWrapperIdentity', () => {
  it('calls the hub a docker shell from /.dockerenv alone, with the seed as its version', () => {
    const identity = detectWrapperIdentity(
      inputs({ dockerEnvFileExists: true, proc1Cgroup: null, seedVersion: '1.1.74' }),
    )
    expect(identity.kind).toBe('docker')
    expect(identity.currentVersion).toBe('1.1.74')
    expect(evidenceFor(identity, 'dockerenv-file').mode).toBe('observed')
    expect(evidenceFor(identity, 'dockerenv-file').holds).toBe(true)
  })

  it('calls it docker from /proc/1/cgroup when /.dockerenv is absent', () => {
    const identity = detectWrapperIdentity(inputs({ proc1Cgroup: LINUX_CONTAINER_CGROUP }))
    expect(identity.kind).toBe('docker')
    // The verbatim read is on the record — an operator has to be able to argue
    // with the verdict, and a boolean gives them nothing to argue with.
    expect(evidenceFor(identity, 'proc-1-cgroup').detail).toContain('docker')
  })

  it('calls it electron ONLY from the version the main process declared', () => {
    const identity = detectWrapperIdentity(
      inputs({ platform: 'darwin', proc1Cgroup: null, electronAppVersion: '1.4.2' }),
    )
    expect(identity.kind).toBe('electron')
    expect(identity.currentVersion).toBe('1.4.2')
    // The one field that CANNOT be observed is marked as declared, always.
    expect(evidenceFor(identity, 'electron-app-version-env').mode).toBe('declared')
  })

  it('REPORTS the contradiction instead of picking a winner', () => {
    const identity = detectWrapperIdentity(
      inputs({
        dockerEnvFileExists: true,
        proc1Cgroup: LINUX_CONTAINER_CGROUP,
        electronAppVersion: '1.4.2',
        seedVersion: '1.2.32',
      }),
    )
    expect(identity.kind).toBe('contradictory')
    // BOTH proofs stay on the record.
    expect(evidenceFor(identity, 'dockerenv-file').holds).toBe(true)
    expect(evidenceFor(identity, 'electron-app-version-env').holds).toBe(true)
    expect(evidenceFor(identity, 'electron-app-version-env').detail).toContain('1.4.2')
    // Which version belongs to the shell is exactly what is contradictory.
    expect(identity.currentVersion).toBeNull()
  })

  it('calls it native only when the container probe actually ANSWERED', () => {
    const identity = detectWrapperIdentity(inputs({ seedVersion: '1.2.32' }))
    expect(identity.kind).toBe('native')
    expect(identity.currentVersion).toBe('1.2.32')
    expect(evidenceFor(identity, 'proc-1-cgroup').holds).toBe(false)
  })

  it('is unknown, NEVER native, when the container probe could not run', () => {
    // Linux, no /.dockerenv, and /proc/1/cgroup unreadable: nothing was
    // excluded, so nothing may be concluded.
    const identity = detectWrapperIdentity(inputs({ proc1Cgroup: null, seedVersion: '1.2.32' }))
    expect(identity.kind).toBe('unknown')
    expect(identity.currentVersion).toBeNull()
  })

  it('treats a non-linux platform as a real exclusion — a linux container cannot run on darwin', () => {
    const identity = detectWrapperIdentity(
      inputs({ platform: 'darwin', proc1Cgroup: null, seedVersion: '1.2.32' }),
    )
    expect(identity.kind).toBe('native')
    expect(evidenceFor(identity, 'platform').detail).toContain('darwin')
  })

  it('ignores an empty CAMSTACK_AGENT_APP_VERSION rather than reading it as electron', () => {
    const identity = detectWrapperIdentity(inputs({ electronAppVersion: '' }))
    expect(identity.kind).toBe('native')
  })

  it('always reports every probe, including the ones that found nothing', () => {
    const identity = detectWrapperIdentity(inputs({}))
    expect(identity.evidence.map((entry) => entry.fact)).toEqual([
      'platform',
      'dockerenv-file',
      'proc-1-cgroup',
      'electron-app-version-env',
    ])
  })
})
