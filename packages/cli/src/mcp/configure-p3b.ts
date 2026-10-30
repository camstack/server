/**
 * Registration of the P3b `configure` families. `configure-tools.ts` calls this
 * once; each family keeps its own file.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAutomationTools } from './configure-automations.js'
import { registerCalibrateTools } from './configure-calibrate.js'
import { registerZonesAlarmTools } from './configure-zones-alarm.js'
import { registerNetworkTools } from './configure-network.js'
import { registerExportTools } from './configure-exports.js'
import { registerOidcTools } from './configure-oidc.js'
import { registerNcRuleTools } from './configure-nc-rules.js'
import type { McpContext } from './context.js'

export function registerConfigureP3bTools(server: McpServer, ctx: McpContext): void {
  registerAutomationTools(server, ctx)
  registerNcRuleTools(server, ctx)
  registerCalibrateTools(server, ctx)
  registerExportTools(server, ctx)
  registerNetworkTools(server, ctx)
  registerOidcTools(server, ctx)
  registerZonesAlarmTools(server, ctx)
}
