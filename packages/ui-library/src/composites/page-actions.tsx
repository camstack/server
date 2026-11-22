/**
 * PageActions — a page header's SECONDARY actions, on one line at every width.
 *
 *   <PageActions
 *     moreLabel={t('common.more', 'More')}
 *     actions={[
 *       { id: 'logs', label: 'Logs', icon: ScrollText, onClick: openLogs },
 *       { id: 'restart', label: 'Restart', icon: RefreshCw,
 *         confirm: { title: 'Restart "MQTT"?', description: '…', action: restart } },
 *       { id: 'delete', label: 'Delete', icon: Trash2, danger: true,
 *         confirm: { title: 'Delete integration?', confirmLabel: 'Delete integration', action: remove } },
 *     ]}
 *   />
 *
 * From `sm` up each action is its own labelled button, as a header has always
 * drawn them. On a phone there is no room for a row of labelled buttons — they
 * wrap onto ragged second lines — so they fold into ONE labelled "More" menu.
 * The page's primary action and its main switch are NOT passed here: they stay
 * beside this, labelled, at every width.
 *
 * An action with `confirm` asks first, with the same dialog in both layouts.
 */
import { type ComponentType, type JSX, type ReactNode, useState } from 'react'
import { useIsPhone } from '../hooks/use-is-mobile'
import { cn } from '../lib/cn'
import { Button } from '../primitives/button'
import { ConfirmActionButton, ConfirmActionDialog } from './confirm-action-button'
import { KebabMenu, type KebabMenuItem } from './kebab-menu'

export interface PageActionConfirm {
  readonly title: string
  readonly description?: ReactNode
  /** Label on the dialog's confirm button. Defaults to the action's label. */
  readonly confirmLabel?: string
  /** Runs on confirm; must throw on failure (shown in the dialog). */
  readonly action: () => Promise<unknown>
}

export interface PageAction {
  /** Stable id for React keys and tests. */
  readonly id: string
  readonly label: string
  readonly icon?: ComponentType<{ className?: string }>
  /** Tooltip on the button. */
  readonly title?: string
  /** The destructive accent. */
  readonly danger?: boolean
  readonly disabled?: boolean
  /** Left out entirely (a gated action). */
  readonly hidden?: boolean
  /** A plain action. Ignored when `confirm` is set. */
  readonly onClick?: () => void
  /** A destructive action: ask first, then run `confirm.action`. */
  readonly confirm?: PageActionConfirm
}

export interface PageActionsProps {
  readonly actions: readonly PageAction[]
  /** The label of the phone menu's trigger ("More"). */
  readonly moreLabel: string
}

const PLAIN_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11px] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground' as const
const DANGER_BUTTON_CLASS =
  'border-danger bg-danger/10 text-danger hover:bg-danger hover:text-background' as const

export function PageActions({ actions, moreLabel }: PageActionsProps): JSX.Element | null {
  const phone = useIsPhone()
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const visible = actions.filter((action) => action.hidden !== true)
  if (visible.length === 0) return null

  if (!phone) {
    return (
      <>
        {visible.map((action) => {
          const Icon = action.icon
          if (action.confirm !== undefined) {
            return (
              <ConfirmActionButton
                key={action.id}
                label={action.label}
                icon={Icon}
                title={action.confirm.title}
                description={action.confirm.description}
                confirmLabel={action.confirm.confirmLabel ?? action.label}
                triggerVariant="outline"
                confirmVariant="danger"
                className={action.danger === true ? DANGER_BUTTON_CLASS : undefined}
                disabled={action.disabled}
                action={action.confirm.action}
              />
            )
          }
          return (
            <Button
              key={action.id}
              variant="unstyled"
              onClick={action.onClick}
              disabled={action.disabled}
              title={action.title}
              className={cn(PLAIN_BUTTON_CLASS, action.danger === true && DANGER_BUTTON_CLASS)}
            >
              {Icon && <Icon className="h-3 w-3" />}
              {action.label}
            </Button>
          )
        })}
      </>
    )
  }

  const confirming = visible.find((action) => action.id === confirmingId)
  const items: readonly KebabMenuItem[] = visible.map((action, index) => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
    danger: action.danger,
    disabled: action.disabled,
    // The destructive ones sit apart at the bottom of the menu.
    separatorBefore: action.danger === true && visible[index - 1]?.danger !== true,
    onClick: () => {
      if (action.confirm !== undefined) setConfirmingId(action.id)
      else action.onClick?.()
    },
  }))
  return (
    <>
      <KebabMenu
        items={items}
        label={moreLabel}
        title={moreLabel}
        triggerClassName="shrink-0 gap-1 border-border bg-surface px-2 py-1.5"
      />
      {confirming?.confirm !== undefined && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmingId(null)
          }}
          title={confirming.confirm.title}
          description={confirming.confirm.description}
          confirmLabel={confirming.confirm.confirmLabel ?? confirming.label}
          action={confirming.confirm.action}
        />
      )}
    </>
  )
}
