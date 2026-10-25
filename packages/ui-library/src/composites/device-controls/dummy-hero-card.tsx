import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import type { DeviceControlProps } from './control-registry'

/** Inline placeholder: renders nothing (no-op row atom for types with no inline control). */
export function DummyInline(_p: DeviceControlProps): ReactNode {
  return (
    <span className="text-foreground-subtle text-xs select-none" aria-hidden="true">
      —
    </span>
  )
}

/** Hero card placeholder: shows a muted "Controls coming soon" card for unimplemented types. */
export function DummyHeroCard(_p: DeviceControlProps): ReactNode {
  const t = useUiText()
  return (
    <div className="rounded border border-border bg-surface-subtle px-3 py-2 text-xs text-foreground-subtle">
      {t('uiLibrary.dummyHeroCard.comingSoon', 'Controls coming soon')}
    </div>
  )
}
