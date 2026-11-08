/**
 * Every device of the operator's Hero A mockups (Tutti1-3), as the hub would serve
 * its hero model: built with the shared pure builder from invented cap slices, so a
 * gap in the model shows up as a missing tile or row next to the mockup. The
 * preview page (`harness/device-module-preview.tsx`) draws each id with the real
 * `DeviceDetailModule`; `hero-compare.ts` shoots it beside the mockup. Ids:
 * 11xx = Tutti1 (climate, appliances, pets), 12xx = Tutti2 (robots, media, home),
 * 13xx = Tutti3 (sensors, switch, the rest).
 */
import { buildHeroModel } from '../../../../packages/types/src/device/hero/build-hero-model.ts'
import { defineFixtures } from './_define'
import { NOW } from './_time'
import { SPECS_TUTTI1 } from './_hero-mockups-1'

export interface MockupSpec {
  readonly name: string
  readonly type: string
  readonly role?: string | null
  readonly provider: string
  readonly caps: readonly string[]
  readonly features?: readonly string[]
  readonly slices: Record<string, unknown>
  readonly remoteCommands?: readonly string[] | null
}

export const MOCKUP_SPECS: Readonly<Record<number, MockupSpec>> = {
  ...SPECS_TUTTI1,
}

export const MOCKUP_IDS: readonly number[] = Object.keys(MOCKUP_SPECS).map(Number)

const binding = (capName: string, provider: string) => ({
  capName,
  kind: 'native',
  providerAddonId: provider,
  providerNodeId: 'hub',
  nativeAddonId: provider,
})

export default defineFixtures({
  area: 'hero-mockups',
  description:
    'Hero A mockup devices (11xx climate/appliances/pets, 12xx robots/media/home, 13xx sensors/rest)',
  handlers: {
    'heroLayout.getHeroModel': (i: { deviceId?: number; canActuate?: boolean }) => {
      const spec = MOCKUP_SPECS[i.deviceId ?? 0]
      if (spec === undefined) return null
      return buildHeroModel({
        device: {
          id: i.deviceId ?? 0,
          type: spec.type,
          role: spec.role ?? null,
          name: spec.name,
          online: true,
        },
        caps: spec.caps,
        features: spec.features ?? [],
        slices: spec.slices,
        now: NOW,
        remoteCommands: spec.remoteCommands ?? null,
        access: { canActuate: i.canActuate !== false },
      })
    },
    'deviceManager.getBindings': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      entries: (MOCKUP_SPECS[i.deviceId]?.caps ?? []).map((c) =>
        binding(c, MOCKUP_SPECS[i.deviceId]?.provider ?? 'provider'),
      ),
    }),
  },
})
