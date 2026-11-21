/** The defaults behind the optional onboarding seams of `McpContext`. */
import { hostCheck } from '../host-check/host-check.js'
import {
  currentPlatform,
  nodeHostFs,
  readHostFacts,
  readNvidiaSmi,
} from '../host-check/node-host.js'
import type { HostProbe, McpContext } from '../mcp/context.js'
import { bundledOnly, type ManifestProvider } from './manifest.js'
import { fileStateStore, type OnboardingStateStore } from './state-file.js'

export const realHost: HostProbe = {
  check() {
    const platform = currentPlatform()
    return hostCheck({
      platform,
      fs: nodeHostFs,
      nvidiaSmi: platform === 'linux' ? readNvidiaSmi() : null,
    })
  },
  facts: (diskPath) => readHostFacts(diskPath),
}

export const manifestOf = (ctx: McpContext): ManifestProvider => ctx.manifest ?? bundledOnly
export const hostOf = (ctx: McpContext): HostProbe => ctx.host ?? realHost
export const stateOf = (ctx: McpContext): OnboardingStateStore =>
  ctx.onboardingState ?? fileStateStore()
