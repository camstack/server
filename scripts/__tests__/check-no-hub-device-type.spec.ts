import { describe, expect, it } from 'vitest'
import { findHubDeviceTypeUses, type HubDeviceTypeSource } from '../check-no-hub-device-type.ts'

function file(rel: string, content: string): HubDeviceTypeSource {
  return { rel, content }
}

describe('hub device type guard', () => {
  it('flags the enum member, the type token, a device-type set and a device comparison', () => {
    const files = [
      file('packages/types/src/device/device-type.ts', "  Hub = 'hub',\n"),
      file('packages/ui-library/src/x.ts', 'const kind = Device' + 'Type.Hub\n'),
      file(
        'packages/ui-library/src/table.ts',
        "const HUB_LIKE_PARENT_TYPES = new Set(['hub', 'nvr'])\n",
      ),
      file('packages/addon/src/row.ts', "if (row.type === 'hub') skip(row)\n"),
      file('packages/addon/src/parent.ts', "if (parentType !== 'hub') return 0\n"),
    ]
    const hits = findHubDeviceTypeUses(files).map((f) => `${f.file}:${f.line}`)
    expect(hits).toEqual([
      'packages/types/src/device/device-type.ts:1',
      'packages/ui-library/src/x.ts:1',
      'packages/ui-library/src/table.ts:1',
      'packages/addon/src/row.ts:1',
      'packages/addon/src/parent.ts:1',
    ])
  })

  it('leaves the node id, placement, the hub database, the integration marker and icon synonyms', () => {
    const files = [
      file(
        'server/backend/src/node-role.ts',
        "if (nodeId === 'hub' || id === 'hub') return 'hub'\n",
      ),
      file('packages/types/src/device/declared-device.ts', "if (placement === 'hub') {\n"),
      file('packages/types/src/ids.ts', "export const HUB_NODE_ID = 'hub'\n"),
      file('packages/system/src/migrations/hub/seed.ts', "  Hub = 'hub'\n"),
      file(
        'packages/addon-provider-reolink/src/hub-connection.ts',
        "export function isHubIntegration() { return info['migratedFromHubDeviceId'] }\n",
      ),
      file(
        'packages/system/src/kernel/moleculer/mesh-mtls/mesh-ca.ts',
        "const RESERVED_NODE_IDS = new Set(['hub'])\n",
      ),
      file(
        'packages/types/src/device/icon-catalog.generated.ts',
        "  Hub = 'hub'\n['internet', 'switch', 'hub', 'modem']\n",
      ),
      file(
        'packages/cli/src/mcp/report-recipes.ts',
        "if (src.type === 'hub') sections.push(hub)\n",
      ),
      file(
        'packages/ui-library/src/node.ts',
        "const nodes = [{ id: 'hub', type: 'hub', location: 'online' }]\n",
      ),
      file(
        'packages/cli/src/mcp/report-scrub.ts',
        "const GENERIC_NAMES = new Set(['hub', 'node', 'agent', 'server', 'camera', 'device'])\n",
      ),
    ]
    expect(findHubDeviceTypeUses(files)).toEqual([])
  })
})
