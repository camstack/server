/**
 * The deploy line has to be able to say "this node is running the new code".
 *
 * On 2026-08-07 `camstack deploy packages/addon-pipeline -n agent-a`
 * printed `✓ agent-a: @camstack/addon-pipeline@1.2.43` four times while
 * the node kept executing the previous dist — the hub installed the bundle and
 * never reloaded it. The tick was indistinguishable from a working deploy, so
 * the day went to hunting a tarball cache that does not exist.
 */
import { describe, expect, it } from 'vitest'
import { checkDeployTarget, describeDeployOutcome } from '../commands/deploy.js'

describe('describeDeployOutcome', () => {
  it('names what the agent reloaded', () => {
    const { detail, warning } = describeDeployOutcome(
      {
        success: true,
        addonId: '@camstack/addon-pipeline',
        reloaded: ['pipeline-runner', 'stream-broker'],
      },
      true,
    )
    expect(detail).toContain('pipeline-runner, stream-broker')
    expect(warning).toBeNull()
  })

  it('WARNS when an agent target reloaded nothing — the silent no-op', () => {
    const { warning } = describeDeployOutcome(
      { success: true, addonId: '@camstack/addon-pipeline', reloaded: [] },
      true,
    )
    expect(warning).toMatch(/still running the\s+previous code/)
  })

  it('WARNS when the node reported no reload field at all (stale hub runtime)', () => {
    const { warning } = describeDeployOutcome(
      { success: true, addonId: '@camstack/addon-pipeline' },
      true,
    )
    expect(warning).toMatch(/predates deploy verification/)
  })

  it('stays quiet for a hub target — the hub install path restarts in the background', () => {
    const { detail, warning } = describeDeployOutcome(
      { success: true, packageName: '@camstack/addon-pipeline', version: '1.2.43' },
      false,
    )
    expect(detail).toBe('@camstack/addon-pipeline@1.2.43')
    expect(warning).toBeNull()
  })
})

/**
 * The target guard.
 *
 * On 2026-08-07 the hub could not see the `nodeId` field of a 4.9 MB upload
 * (the CLI sent it AFTER the file part, and the hub read the busboy body before
 * draining the file). Every `-n agent-a` push installed on the HUB and
 * answered `target: "hub"`, while this CLI printed `✓ agent-a`. Four
 * reproductions were spent looking for a stale dist on a node that had never
 * been addressed.
 */
describe('checkDeployTarget', () => {
  it('fails when the hub installed somewhere other than the node we named', () => {
    const problem = checkDeployTarget({ success: true, target: 'hub' }, 'agent-a')
    expect(problem).toMatch(/installed this on "hub", NOT on "agent-a"/)
  })

  it('passes when the hub used the node we named', () => {
    expect(checkDeployTarget({ success: true, target: 'agent-a' }, 'agent-a')).toBeNull()
  })

  it('treats an absent nodeId as the hub target', () => {
    expect(checkDeployTarget({ success: true, target: 'hub' }, undefined)).toBeNull()
    expect(checkDeployTarget({ success: true, target: 'agent-a' }, undefined)).toMatch(
      /NOT on "hub"/,
    )
  })

  it('stays silent against a hub too old to echo a target', () => {
    expect(checkDeployTarget({ success: true }, 'agent-a')).toBeNull()
  })
})
