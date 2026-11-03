import { vi } from 'vitest'

/**
 * The hub's `migrations` cap as `BaseAddon.runMigrations` reaches it through `ctx.api`.
 * A production addon context always carries it; a spec context built by hand must too.
 * This engine owns an empty step list, so a catalogue runs nothing and the specs see the
 * settings they seeded.
 */
export function makeMigrationsApi() {
  return {
    migrations: {
      declareOwner: {
        mutate: vi.fn(async () => ({ bootId: 'spec-boot', snapshot: 'none', steps: [] })),
      },
      startMigration: {
        mutate: vi.fn(async () => ({ proceed: false, state: 'applied', reason: null })),
      },
      finishMigration: {
        mutate: vi.fn(async () => ({ status: 'applied', error: null })),
      },
    },
  }
}
