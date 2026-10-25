import { useUiText } from '../contexts/ui-text'
/**
 * RoleNodePill — with a role: chrome tinted by ROLE (Detection / Decode /
 * Audio) and a trailing node-colour dot. Without a role: colour icon + name
 * only (Nodes selector and similar).
 */
import type { NodeColorId } from '@camstack/types'
import type { JSX, ReactNode } from 'react'
import { Pin } from 'lucide-react'
import { cn } from '../lib/cn'
import { nodeColorClass, nodeTextColorClass } from './node-color'

/** Stable ids for the three camera roles on Assignments. */
export type PipelineRoleId = 'detection' | 'decode' | 'audio'

const ROLE_SOFT_CLASS = {
  detection: 'bg-info/12 text-info ring-info/35',
  decode: 'bg-warning/12 text-warning ring-warning/35',
  audio: 'bg-success/12 text-success ring-success/35',
} satisfies Record<PipelineRoleId, string>

const ROLE_EMPHASIZED_CLASS = {
  detection: 'bg-info/22 text-info ring-info/55',
  decode: 'bg-warning/22 text-warning ring-warning/55',
  audio: 'bg-success/22 text-success ring-success/55',
} satisfies Record<PipelineRoleId, string>

/** Full class strings so Tailwind v4 JIT retains node palette opacity utilities. */
const NODE_BG_SOFT_CLASS = {
  'node-a': 'bg-node-a/12',
  'node-b': 'bg-node-b/12',
  'node-c': 'bg-node-c/12',
  'node-d': 'bg-node-d/12',
  'node-e': 'bg-node-e/12',
  'node-f': 'bg-node-f/12',
  'node-g': 'bg-node-g/12',
  'node-h': 'bg-node-h/12',
} satisfies Record<NodeColorId, string>

const NODE_BG_EMPHASIZED_CLASS = {
  'node-a': 'bg-node-a/22',
  'node-b': 'bg-node-b/22',
  'node-c': 'bg-node-c/22',
  'node-d': 'bg-node-d/22',
  'node-e': 'bg-node-e/22',
  'node-f': 'bg-node-f/22',
  'node-g': 'bg-node-g/22',
  'node-h': 'bg-node-h/22',
} satisfies Record<NodeColorId, string>

const NODE_RING_CLASS = {
  'node-a': 'ring-node-a/45',
  'node-b': 'ring-node-b/45',
  'node-c': 'ring-node-c/45',
  'node-d': 'ring-node-d/45',
  'node-e': 'ring-node-e/45',
  'node-f': 'ring-node-f/45',
  'node-g': 'ring-node-g/45',
  'node-h': 'ring-node-h/45',
} satisfies Record<NodeColorId, string>

export interface RoleNodePillProps {
  /** When omitted, the pill is colour icon + node name only. */
  readonly roleLabel?: string
  /** When set with a role label, chrome uses role tones instead of node palette. */
  readonly roleId?: PipelineRoleId
  readonly nodeName: string
  /** Node palette — trailing host dot (and full chrome when there is no roleId). */
  readonly colorId: NodeColorId
  readonly emphasized?: boolean
  readonly pinned?: boolean
  /** When set, the pill is a selectable control (`role="tab"`). */
  readonly onSelect?: () => void
  readonly disabled?: boolean
  /** Extra trailing content inside the pill (e.g. "offline"). */
  readonly trailing?: ReactNode
}

export function RoleNodePill({
  roleLabel,
  roleId,
  nodeName,
  colorId,
  emphasized = false,
  pinned = false,
  onSelect,
  disabled = false,
  trailing,
}: RoleNodePillProps): JSX.Element {
  const t = useUiText()
  const title =
    roleLabel !== undefined
      ? pinned
        ? `${roleLabel} pinned on ${nodeName}`
        : `${roleLabel} on ${nodeName}`
      : nodeName

  const roleChrome = roleLabel !== undefined && roleId !== undefined
  const className = cn(
    'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-tight ring-1 ring-inset',
    roleChrome
      ? emphasized
        ? cn('role-node-pill-emphasized font-semibold ring-2', ROLE_EMPHASIZED_CLASS[roleId])
        : cn('font-medium', ROLE_SOFT_CLASS[roleId])
      : emphasized
        ? cn(
            'role-node-pill-emphasized font-semibold ring-2',
            NODE_BG_EMPHASIZED_CLASS[colorId],
            NODE_RING_CLASS[colorId],
            nodeTextColorClass(colorId),
          )
        : cn('font-medium text-foreground-muted ring-border/60', NODE_BG_SOFT_CLASS[colorId]),
    onSelect !== undefined &&
      !disabled &&
      'cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
    disabled && 'cursor-not-allowed opacity-50',
  )

  const colorIcon = (
    <span
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', nodeColorClass(colorId))}
      aria-hidden
    />
  )

  const body =
    roleLabel !== undefined ? (
      <>
        {pinned && (
          <Pin
            className="h-2.5 w-2.5 shrink-0 opacity-80"
            aria-label={t('uiLibrary.roleNodePill.pinned', 'pinned')}
          />
        )}
        <span className="shrink-0">{roleLabel}</span>
        <span
          className={cn(
            'min-w-0 truncate',
            roleChrome
              ? 'opacity-80'
              : emphasized
                ? nodeTextColorClass(colorId)
                : 'text-foreground-subtle',
          )}
        >
          {nodeName}
        </span>
        {colorIcon}
      </>
    ) : (
      <>
        {colorIcon}
        <span
          className={cn(
            'min-w-0 truncate font-medium',
            emphasized ? nodeTextColorClass(colorId) : 'text-foreground',
          )}
        >
          {nodeName}
        </span>
        {trailing}
      </>
    )

  if (onSelect !== undefined) {
    return (
      // ui-check-ok: selectable RoleNodePill keeps palette ring/chrome; Button sizes fight the 10px pill
      <button
        type="button"
        role="tab"
        aria-selected={emphasized}
        data-testid="role-node-pill"
        data-role={roleId}
        title={title}
        disabled={disabled}
        onClick={onSelect}
        className={className}
      >
        {body}
      </button>
    )
  }

  return (
    <span data-testid="role-node-pill" data-role={roleId} title={title} className={className}>
      {body}
    </span>
  )
}
