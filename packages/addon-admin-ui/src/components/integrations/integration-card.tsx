/**
 * The integration card shared by the Integrations grid and the New Integration
 * picker: a large addon icon on the left, the name on top, a body in the
 * middle and a footer line at the bottom. The whole card is one button; the
 * caller supplies what the body and the footer say.
 */
import { type ReactElement, type ReactNode } from 'react'
import { Button } from '@camstack/ui-library'
import { ProviderIcon } from '../shared/ProviderIcon'

/** 1 column on a phone, 2 in between, 3 on wide screens. */
export function IntegrationCardGrid({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">{children}</div>
  )
}

export interface IntegrationCardProps {
  readonly addonId: string
  readonly name: string
  readonly openLabel: string
  readonly onOpen: () => void
  readonly body: ReactNode
  readonly footer?: ReactNode
  readonly disabled?: boolean
  readonly testId: string
  readonly buttonTestId?: string
}

export function IntegrationCard({
  addonId,
  name,
  openLabel,
  onOpen,
  body,
  footer,
  disabled = false,
  testId,
  buttonTestId,
}: IntegrationCardProps): ReactElement {
  return (
    <article
      data-testid={testId}
      className="relative flex min-w-0 items-stretch gap-3 overflow-x-clip rounded-lg border border-border bg-surface p-3"
    >
      <Button
        type="button"
        variant="ghost"
        aria-label={openLabel}
        disabled={disabled}
        data-testid={buttonTestId}
        onClick={onOpen}
        className="absolute inset-0 z-0 h-auto w-auto rounded-lg p-0 focus-visible:ring-2 focus-visible:ring-primary"
      />
      <div className="pointer-events-none relative z-10 flex w-20 shrink-0 items-center justify-center">
        <ProviderIcon type={addonId} size="xl" />
      </div>
      <div className="pointer-events-none relative z-10 grid min-w-0 flex-1 grid-rows-[1fr_auto_1fr] gap-1">
        <p className="min-w-0 self-start truncate text-sm font-semibold text-foreground">{name}</p>
        {body}
        <div className="self-end justify-self-start">{footer}</div>
      </div>
    </article>
  )
}
