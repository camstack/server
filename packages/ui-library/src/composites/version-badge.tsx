import React from 'react'
import { cn } from '../lib/cn'
import { type JSX } from 'react'

export type SemanticBadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const VARIANT_STYLES: Record<SemanticBadgeVariant, string> = {
  success: 'bg-emerald-400 text-emerald-950',
  warning: 'bg-amber-400 text-amber-950',
  danger: 'bg-red-400 text-red-950',
  info: 'bg-blue-400 text-blue-950',
  neutral: 'bg-foreground-subtle/20 text-foreground',
}

export interface SemanticBadgeProps {
  children: React.ReactNode
  variant?: SemanticBadgeVariant
  /** Use monospace font (good for versions, codes) */
  mono?: boolean
  className?: string
}

/**
 * General-purpose badge with semantic color variants.
 * Solid background with dark text for maximum contrast.
 */
export function SemanticBadge({
  children,
  variant = 'neutral',
  mono,
  className,
}: SemanticBadgeProps): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold leading-tight',
        mono && 'font-mono',
        VARIANT_STYLES[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}

// --- Convenience wrappers ---

export interface VersionBadgeProps {
  version: string
  preRelease?: boolean
  className?: string
}

/**
 * Version badge — auto-detects pre-release versions.
 * Stable = success (green), Pre-release = warning (amber).
 */
export function VersionBadge({ version, preRelease, className }: VersionBadgeProps): JSX.Element {
  const isPreRelease = preRelease ?? /-(alpha|beta|rc|dev|canary|next)/i.test(version)
  return (
    <SemanticBadge variant={isPreRelease ? 'warning' : 'success'} mono className={className}>
      {version}
    </SemanticBadge>
  )
}
