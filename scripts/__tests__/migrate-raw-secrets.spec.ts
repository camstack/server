import { describe, expect, it } from 'vitest'
import {
  allVerified,
  formatResult,
  OWNER_ROUTES,
  parseArgs,
  runMigration,
  type HubMutate,
} from '../hub/migrate-raw-secrets.ts'

const REPORT = {
  apply: true,
  rows: 3,
  raw: 2,
  markers: 1,
  migrated: 2,
  failed: 0,
  remainingRaw: 0,
  unresolvedMarkers: 0,
  verified: true,
}

function hub(answer: unknown): { hub: HubMutate; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    hub: {
      mutate: async (route, input) => {
        calls.push([route, input])
        return answer
      },
    },
  }
}

describe('migrate-raw-secrets', () => {
  it('refuses to pick a hub', () => {
    expect(parseArgs([])).toContain('--server')
    expect(parseArgs(['--server', 'h'])).toEqual({ server: 'h', tokenFile: null, apply: false })
    expect(parseArgs(['--server', 'h', '--apply'])).toMatchObject({ apply: true })
  })

  it('calls every owner with the apply flag and nothing else', async () => {
    const h = hub(REPORT)
    await runMigration(h.hub, false)
    expect(h.calls).toEqual(OWNER_ROUTES.map((o) => [o.route, o.input(false)]))
    expect(h.calls.map(([route]) => route)).toEqual([
      'llm.migrateRawSecrets',
      'userManagement.migrateRawSecrets',
      'coreBlocks.migrateRawSecrets',
      'addons.custom',
    ])
  })

  it('reaches the waste migration through the addon custom action', async () => {
    const h = hub(REPORT)
    await runMigration(h.hub, true)
    expect(h.calls.at(-1)).toEqual([
      'addons.custom',
      { addonId: 'waste-collections', action: 'migrateSources', input: { apply: true } },
    ])
  })

  it('prints the redundant-copy count when an owner reports one, and only then', async () => {
    const withCopies = await runMigration(hub({ ...REPORT, redundantCopies: 2 }).hub, true)
    expect(formatResult(withCopies[0]!, true)).toContain('redundant copies found 2')
    const without = await runMigration(hub(REPORT).hub, true)
    expect(formatResult(without[0]!, true)).not.toContain('redundant')
  })

  it('prints counts only', async () => {
    const results = await runMigration(hub(REPORT).hub, true)
    const text = results.map((r) => formatResult(r, true)).join('\n')
    expect(text).toContain('migrated 2')
    expect(text).not.toMatch(/secret:\/\//)
    expect(allVerified(results)).toBe(true)
  })

  it('a leftover raw row or an unresolved marker is not verified', async () => {
    const results = await runMigration(
      hub({ ...REPORT, remainingRaw: 1, verified: false }).hub,
      true,
    )
    expect(allVerified(results)).toBe(false)
  })

  it('rejects an answer of an unexpected shape', async () => {
    await expect(runMigration(hub({ rows: 'x' }).hub, true)).rejects.toThrow()
  })
})
