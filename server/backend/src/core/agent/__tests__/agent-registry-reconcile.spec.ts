import { describe, expect, it, vi } from 'vitest'
import type { AddonRegistryService } from '../../addon/addon-registry.service'
import type { CapabilityService } from '../../capability/capability.service'
import type { EventBusService } from '../../events/event-bus.service'
import type { MoleculerService } from '../../moleculer/moleculer.service'
import { AgentRegistryService } from '../agent-registry.service'

/**
 * Regression: the hub reconcile must NEVER undeploy the agent's own
 * `@camstack/system` infrastructure builtins. They are bootstrap
 * infrastructure (storage/settings/metrics/logging) that runs on every
 * node and is absent from the hub's installed-addon set, so the naive
 * "not installed on hub → stale" rule wrongly flagged them and tore down
 * the agent's own storage — bricking the node and making it unroutable.
 */
interface HubAddonRow {
  readonly manifest: { readonly id: string; readonly packageName: string }
  readonly declaration: { readonly id: string; readonly execution: { readonly placement: string } }
}

// Hub installed-addon set default: only the genuinely-deployable agent addon
// `onvif` is "installed" (any-node placement); the system builtins are
// NOT here (they are in-process infrastructure, never listed).
const DEFAULT_HUB_ROWS: readonly HubAddonRow[] = [
  {
    manifest: { id: 'onvif', packageName: '@camstack/addon-provider-onvif' },
    declaration: { id: 'onvif', execution: { placement: 'any-node' } },
  },
]

function makeService(
  agentAddons: ReadonlyArray<{ id: string; packageName?: string }>,
  hubRows: readonly HubAddonRow[] = DEFAULT_HUB_ROWS,
) {
  const undeployed: string[] = []

  const broker = {
    call: vi.fn(async (action: string, params?: Record<string, unknown>) => {
      if (action === '$agent.status') return { addons: agentAddons }
      if (action === '$agent.undeploy') {
        undeployed.push(String(params?.['addonId']))
        return { ok: true }
      }
      return undefined
    }),
    waitForServices: vi.fn(async () => undefined),
    localBus: { on: vi.fn() },
  }

  const moleculer = { broker } as unknown as MoleculerService
  const eventBus = { emit: vi.fn() } as unknown as EventBusService
  const capabilityService = {} as unknown as CapabilityService

  const service = new AgentRegistryService(eventBus, moleculer, capabilityService)

  const addonRegistry = {
    listAddons: () => hubRows,
  } as unknown as AddonRegistryService
  service.setAddonRegistry(addonRegistry)

  return { service, undeployed }
}

describe('AgentRegistryService.reconcileAgentAddons — system-builtin guard', () => {
  it('does not undeploy @camstack/system builtins even though they are absent from the hub set', async () => {
    const { service, undeployed } = makeService([
      { id: 'filesystem-storage', packageName: '@camstack/system' },
      { id: 'storage-orchestrator', packageName: '@camstack/system' },
      { id: 'sqlite-settings', packageName: '@camstack/system' },
      { id: 'metrics-native', packageName: '@camstack/system' },
      { id: 'onvif', packageName: '@camstack/addon-provider-onvif' },
    ])

    await service.reconcileAgentAddons('agent-a')

    expect(undeployed).toEqual([])
  })

  it('does not undeploy the agent-only @camstack/addon-agent-ui dashboard (absent from hub set)', async () => {
    // agent-ui is agent-only bootstrap infra: seeded by the agent, never
    // installed on the hub, so it is missing from `hubPlacements`. Before the
    // AGENT_BOOTSTRAP_PACKAGES allowlist the reconcile undeployed it →
    // deleted its /data dir → its forked runner crash-looped on the missing
    // package until the circuit-breaker tripped.
    const { service, undeployed } = makeService([
      { id: 'agent-ui', packageName: '@camstack/addon-agent-ui' },
      { id: 'sqlite-settings', packageName: '@camstack/system' },
      { id: 'onvif', packageName: '@camstack/addon-provider-onvif' },
    ])

    await service.reconcileAgentAddons('agent-a')

    expect(undeployed).toEqual([])
  })

  it('still undeploys a genuinely stale addon that is not installed on the hub', async () => {
    const { service, undeployed } = makeService([
      { id: 'sqlite-settings', packageName: '@camstack/system' },
      { id: 'ghost-addon', packageName: '@camstack/addon-ghost' },
    ])

    await service.reconcileAgentAddons('agent-a')

    expect(undeployed).toEqual(['ghost-addon'])
  })
})

/**
 * Regression: version-skew sibling decl-ids must NOT be undeployed.
 *
 * When an agent runs a NEWER bundle of a package the hub also ships, the
 * agent can report a decl-id the older hub has never heard of (e.g. a new
 * `decoder-nodeav` addon added inside `@camstack/addon-pipeline`). The naive
 * "decl-id absent from hub → stale" rule undeployed it, and the agent's
 * undeploy handler removed the ENTIRE shared package dir — wiping every
 * sibling runner (decoder-ffmpeg, recorder, motion-wasm, …), which then
 * crash-looped on the missing package.json.
 */
describe('AgentRegistryService.reconcileAgentAddons — version-skew package guard', () => {
  const PIPELINE_HUB_ROWS: readonly HubAddonRow[] = [
    {
      manifest: { id: 'decoder-ffmpeg', packageName: '@camstack/addon-pipeline' },
      declaration: { id: 'decoder-ffmpeg', execution: { placement: 'any-node' } },
    },
    {
      manifest: { id: 'recorder', packageName: '@camstack/addon-pipeline' },
      declaration: { id: 'recorder', execution: { placement: 'any-node' } },
    },
  ]

  it('does not undeploy an unknown decl-id whose PACKAGE the hub ships (newer agent bundle)', async () => {
    const { service, undeployed } = makeService(
      [
        // Unknown to the hub — added by a newer addon-pipeline bundle on the agent.
        { id: 'decoder-nodeav', packageName: '@camstack/addon-pipeline' },
        // Known sibling from the same shared package.
        { id: 'decoder-ffmpeg', packageName: '@camstack/addon-pipeline' },
      ],
      PIPELINE_HUB_ROWS,
    )

    await service.reconcileAgentAddons('agent-a')

    expect(undeployed).toEqual([])
  })

  it('still undeploys an addon whose PACKAGE is entirely absent from the hub', async () => {
    const { service, undeployed } = makeService(
      [
        { id: 'decoder-ffmpeg', packageName: '@camstack/addon-pipeline' },
        { id: 'ghost-addon', packageName: '@camstack/addon-ghost' },
      ],
      PIPELINE_HUB_ROWS,
    )

    await service.reconcileAgentAddons('agent-a')

    expect(undeployed).toEqual(['ghost-addon'])
  })

  it('still undeploys a KNOWN decl-id with hub-only placement even when the package is shared', async () => {
    const hubRows: readonly HubAddonRow[] = [
      ...PIPELINE_HUB_ROWS,
      {
        manifest: { id: 'stream-broker', packageName: '@camstack/addon-pipeline' },
        declaration: { id: 'stream-broker', execution: { placement: 'hub-only' } },
      },
    ]
    const { service, undeployed } = makeService(
      [
        { id: 'decoder-ffmpeg', packageName: '@camstack/addon-pipeline' },
        { id: 'stream-broker', packageName: '@camstack/addon-pipeline' },
      ],
      hubRows,
    )

    await service.reconcileAgentAddons('agent-a')

    expect(undeployed).toEqual(['stream-broker'])
  })
})
