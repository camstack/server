import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

/** A colour the DEVICE reports (data, not a theme colour), 0..255 per channel. */
export interface LightRgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface LightIllustrationProps {
  readonly on: boolean
  /** The light's own colour; null draws the theme's lit colour. */
  readonly color: LightRgb | null
  /** 0..100, or null for a light without a level. */
  readonly brightness: number | null
  readonly className?: string
}

const BULB = 'M60 12a38 38 0 0 0-22 69c5 4 8 9 8 15v6h28v-6c0-6 3-11 8-15a38 38 0 0 0-22-69z'
/** How strong the halo is at a brightness, as in the approved drawing. */
const glowOpacity = (brightness: number | null): number => 0.12 + ((brightness ?? 60) / 100) * 0.45

export const rgbCss = ({ r, g, b }: LightRgb): string => `rgb(${r} ${g} ${b})` // ui-check-ok: a device-reported colour (data), not a theme colour

/** A bulb lit in the light's colour, its halo as strong as the brightness. Grey when off. */
export function LightIllustration({
  on,
  color,
  brightness,
  className,
}: LightIllustrationProps): ReactElement {
  const lit = on && color !== null ? rgbCss(color) : undefined
  return (
    <svg
      viewBox="0 0 120 140"
      aria-hidden
      data-on={on}
      className={cn(on ? 'text-primary' : 'text-foreground-muted', className)}
    >
      {on ? (
        <circle
          cx={60}
          cy={54}
          r={56}
          className="fill-current"
          style={{ fill: lit, opacity: glowOpacity(brightness) }} // ui-check-ok: the device's colour (data) and a halo computed from its brightness
        />
      ) : null}
      <path
        d={BULB}
        className={on ? 'fill-current' : 'fill-surface-hover stroke-border'}
        strokeWidth={on ? 0 : 2}
        style={lit === undefined ? undefined : { fill: lit }} // ui-check-ok: the device's colour (data)
      />
      <rect x={46} y={106} width={28} height={7} rx={3} className="fill-foreground-muted" />
      <rect x={49} y={116} width={22} height={7} rx={3} className="fill-foreground-muted" />
    </svg>
  )
}
