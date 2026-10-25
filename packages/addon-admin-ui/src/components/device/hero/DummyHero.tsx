import type { ReactElement } from 'react'
import { DummyHeroCard } from '@camstack/ui-library'
import { useSystem } from '@camstack/ui-library'
import type { HeroProps } from './HeroRegistry'

/**
 * Dummy hero for controllable device types that don't yet have a real
 * hero implementation (Lock, Fan, Thermostat, MediaPlayer, Control,
 * AlarmPanel, Notifier, Script, Automation, Presence). Renders the
 * shared `DummyHeroCard` placeholder from ui-library ("Controls coming
 * soon"). Each type will be replaced with a real hero in later
 * iterations — the entry in `HERO_REGISTRY` makes the intent explicit
 * and avoids falling back to `GenericHero` (the identity card) which
 * would mislead operators into thinking there are no controls planned.
 */
export function DummyHero({ deviceId, features }: HeroProps): ReactElement {
  const system = useSystem()
  return (
    <div className="flex h-full w-full flex-col items-stretch p-3 sm:p-4">
      <DummyHeroCard trpc={system.trpcClient} deviceId={deviceId} features={features} />
    </div>
  )
}
