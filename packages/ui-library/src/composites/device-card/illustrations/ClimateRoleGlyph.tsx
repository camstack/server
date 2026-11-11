import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export const CLIMATE_ROLES = [
  'ac',
  'thermostat',
  'floor',
  'radiator',
  'heater',
  'hpcircuit',
] as const
export type ClimateRole = (typeof CLIMATE_ROLES)[number]

const SHAPES: Readonly<Record<ClimateRole, ReactElement>> = {
  ac: (
    <>
      <rect x={2} y={4} width={24} height={10} rx={3} />
      <path d="M6 18v3M14 18v4M22 18v3" />
    </>
  ),
  thermostat: (
    <>
      <circle cx={14} cy={13} r={10} />
      <path d="M14 13l4-4" />
    </>
  ),
  floor: (
    <>
      <path d="M3 8h22v5H3v5h22" />
      <path d="M2 23h24" />
    </>
  ),
  radiator: (
    <>
      <rect x={3} y={4} width={5} height={17} rx={2} />
      <rect x={11.5} y={4} width={5} height={17} rx={2} />
      <rect x={20} y={4} width={5} height={17} rx={2} />
      <path d="M2 21h24" />
    </>
  ),
  heater: (
    <>
      <rect x={3} y={4} width={22} height={17} rx={4} />
      <path d="M7 10h14M7 15h14" />
    </>
  ),
  hpcircuit: (
    <>
      <path d="M2 5h19a4 4 0 0 1 0 8H7a4 4 0 0 0 0 8h19" />
      <path d="M22 18l4 3-4 3" />
    </>
  ),
}

export interface ClimateRoleGlyphProps {
  readonly role: ClimateRole
  readonly className?: string
}

/** The small drawing in the dial's gap that says WHAT heats or cools. */
export function ClimateRoleGlyph({ role, className }: ClimateRoleGlyphProps): ReactElement {
  return (
    <svg
      viewBox="0 0 28 26"
      aria-hidden
      data-role={role}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-6 w-6.5', className)}
    >
      {SHAPES[role]}
    </svg>
  )
}
