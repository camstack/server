import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { HeroScene, type HeroSceneProps } from './hero-scene'

export interface DeviceRowProps {
  /** The mini scene: the same scene id + params a hero would draw. */
  readonly scene: Pick<
    HeroSceneProps,
    'scene' | 'state' | 'level' | 'speed' | 'timer' | 'points' | 'tone' | 'icon'
  >
  readonly name: string
  /** The one status line under the name. */
  readonly status?: string
  /** The primary control (toggle, stepper, button). It stays at phone width. */
  readonly control?: ReactNode
  /** Trailing fact chip (power, last seen). Hidden at phone width. */
  readonly fact?: ReactNode
  readonly onSelect?: () => void
  readonly className?: string
}

/**
 * The shared device row: a fixed four-zone grid — mini scene (44×44), name +
 * one status line, primary control, trailing fact. Below `sm` the fact zone is
 * dropped and the control stays.
 */
export function DeviceRow({
  scene,
  name,
  status,
  control,
  fact,
  onSelect,
  className,
}: DeviceRowProps): ReactNode {
  return (
    <div
      data-testid="device-row"
      className={cn(
        'grid min-h-16 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border-subtle px-3.5 py-2.5 first:border-t-0 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto_auto]',
        className,
      )}
    >
      <div data-zone="scene">
        <HeroScene size="mini" {...scene} />
      </div>
      <div data-zone="name" className="min-w-0">
        {onSelect !== undefined ? (
          <Button
            variant="unstyled"
            onClick={onSelect}
            className="block w-full truncate text-left text-sm font-semibold text-foreground hover:underline"
          >
            {name}
          </Button>
        ) : (
          <div className="truncate text-sm font-semibold text-foreground">{name}</div>
        )}
        {status !== undefined ? (
          <div
            data-testid="device-row-status"
            className="truncate whitespace-nowrap text-xs text-foreground-muted"
          >
            {status}
          </div>
        ) : null}
      </div>
      <div data-zone="control" className="flex shrink-0 items-center justify-end">
        {control}
      </div>
      <div data-zone="fact" className="hidden shrink-0 items-center justify-end sm:flex">
        {fact}
      </div>
    </div>
  )
}
