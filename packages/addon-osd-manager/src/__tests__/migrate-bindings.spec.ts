import { describe, expect, it } from 'vitest'
import { OsdManagerAddon } from '../addon.js'

class Probe extends OsdManagerAddon {
  run(ctx: Parameters<OsdManagerAddon['migrateBindings']>[0]): Promise<void> {
    return this.migrateBindings(ctx)
  }
}

describe('the OSD manager boot migration', () => {
  it('logs and skips when the settings store or the migration API is missing', async () => {
    const lines: string[] = []
    const logger = { warn: (message: string) => void lines.push(message) }
    // A migration run would throw here (the Probe has no context); a skip resolves.
    await expect(
      new Probe().run({ settings: undefined, migrationApi: undefined, logger }),
    ).resolves.toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('migration is skipped')
  })
})
