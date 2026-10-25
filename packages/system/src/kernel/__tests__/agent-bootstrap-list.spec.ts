/**
 * AGENT_PACKAGES derivation — single source of truth.
 *
 * The agent bootstrap list is derived from the `@camstack/server`
 * meta-package's `camstack.agentBootstrapAddons` manifest field (the
 * separate agent meta-package has been removed). The agent runtime boots
 * from the SAME `@camstack/server` closure, so its bootstrap addon set is
 * declared alongside the hub's rather than in a second package.
 *
 * Contract: `AGENT_PACKAGES = ['@camstack/system', ...agentBootstrapAddons]`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

function repoRoot(): string {
  // this file lives at packages/system/src/kernel/__tests__/… — five ../ up
  return path.resolve(__dirname, '..', '..', '..', '..', '..')
}

interface ServerPackageJson {
  readonly camstack?: {
    readonly agentBootstrapAddons?: readonly string[]
    readonly agentOnlyBootstrapAddons?: readonly string[]
  }
}

function serverCamstack(): ServerPackageJson['camstack'] {
  const raw = fs.readFileSync(path.join(repoRoot(), 'server', 'backend', 'package.json'), 'utf8')
  const parsed = JSON.parse(raw) as ServerPackageJson
  return parsed.camstack
}

function serverAgentBootstrapAddons(): readonly string[] {
  return serverCamstack()?.agentBootstrapAddons ?? []
}

function serverAgentOnlyBootstrapAddons(): readonly string[] {
  return serverCamstack()?.agentOnlyBootstrapAddons ?? []
}

describe('AGENT_PACKAGES derivation', () => {
  it('derives from @camstack/server camstack.agentBootstrapAddons + system', () => {
    expect(AddonInstaller.AGENT_PACKAGES).toContain('@camstack/system')
    expect(AddonInstaller.AGENT_PACKAGES).toContain('@camstack/addon-agent-ui')
    expect(AddonInstaller.AGENT_PACKAGES).not.toContain('@camstack/addon-admin-ui')
  })

  it('AGENT_PACKAGES = @camstack/system + the server manifest agentBootstrapAddons', () => {
    const expected = ['@camstack/system', ...serverAgentBootstrapAddons()].toSorted()
    expect([...AddonInstaller.AGENT_PACKAGES].toSorted()).toEqual(expected)
  })

  it('REQUIRED_PACKAGES (hub bootstrap) EXCLUDES agent-only bootstrap addons', () => {
    // Agent-only addons (e.g. @camstack/addon-agent-ui) are carried in the
    // @camstack/server closure so agent-role nodes can seed them, but they
    // MUST NOT be part of the HUB bootstrap set — the hub never installs them.
    for (const agentOnly of serverAgentOnlyBootstrapAddons()) {
      expect(AddonInstaller.REQUIRED_PACKAGES).not.toContain(agentOnly)
    }
    // Concretely, agent-ui must be excluded from the hub REQUIRED_PACKAGES.
    expect(AddonInstaller.REQUIRED_PACKAGES).not.toContain('@camstack/addon-agent-ui')
  })
})
