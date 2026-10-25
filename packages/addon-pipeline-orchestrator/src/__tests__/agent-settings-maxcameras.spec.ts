import { describe, it, expect } from 'vitest'
import { AgentSettingsMapSchema } from '../orchestrator-store-schemas.js'

describe('AgentSettingsMapSchema — maxCameras', () => {
  it('accepts a per-node maxCameras number', () => {
    const parsed = AgentSettingsMapSchema.parse({ little: { addonDefaults: {}, maxCameras: 4 } })
    expect(parsed.little?.maxCameras).toBe(4)
  })
  it('defaults maxCameras to null (unlimited) when omitted', () => {
    const parsed = AgentSettingsMapSchema.parse({ hub: { addonDefaults: {} } })
    expect(parsed.hub?.maxCameras).toBeNull()
  })
})
