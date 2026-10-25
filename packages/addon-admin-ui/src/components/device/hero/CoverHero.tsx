import type { ReactElement } from 'react'
import { CoverHeroCard } from '@camstack/ui-library'
import { useSystem } from '@camstack/ui-library'
import type { HeroProps } from './HeroRegistry'

/**
 * Cover hero — delegates to the shared `CoverHeroCard` from ui-library.
 *
 * The card renders ↑■↓ buttons, % open, and position/tilt sliders
 * (sliders gated on CoverPositionable / CoverTilt features). Trpc is
 * sourced via `useSystem().trpcClient` — the same pattern used by
 * SwitchHero / LightHero / SensorHero.
 */
export function CoverHero({ deviceId, features }: HeroProps): ReactElement {
  const system = useSystem()
  return (
    <div className="flex h-full w-full flex-col items-stretch gap-3 p-3 sm:p-4">
      <CoverHeroCard trpc={system.trpcClient} deviceId={deviceId} features={features} />
    </div>
  )
}
