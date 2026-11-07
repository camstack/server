/**
 * The running row's "Follow the device's switch" toggle. ON is the default (no
 * rule stored); OFF stores the opt-out. Turning it ON over a rule the operator
 * wrote asks first, because the rule goes.
 */
import { Switch, useConfirm } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentComposition } from '../customization-read'
import type { CustomizationHandle } from '../use-customization'
import { readFollowSwitch, saveFollowSwitch } from './follow-switch'

export interface FollowSwitchToggleProps {
  readonly handle: CustomizationHandle
}

export function FollowSwitchToggle({ handle }: FollowSwitchToggleProps): ReactNode {
  const { t } = useTranslation()
  const [refusal, setRefusal] = useState<string | null>(null)
  const confirm = useConfirm()
  const current = currentComposition(handle.state)
  const read = readFollowSwitch(current)
  if (current === null || !read.offered) return null
  const move = async (follow: boolean): Promise<void> => {
    if (follow && read.discardsRule) {
      const ok = await confirm({
        title: t('customize.followSwitch.discardTitle'),
        message: t('customize.followSwitch.discardMessage'),
        confirmLabel: t('customize.followSwitch.discardConfirm'),
        variant: 'danger',
      })
      if (!ok) return
    }
    const outcome = await handle.save(saveFollowSwitch(current, follow))
    setRefusal(outcome.kind === 'refused' ? outcome.reason : null)
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2 text-xs text-foreground">
        <Switch
          checked={read.following}
          disabled={handle.saving}
          label={t('customize.followSwitch.label')}
          data-testid="follow-switch-toggle"
          onCheckedChange={(next) => void move(next)}
        />
      </span>
      {refusal !== null && (
        <span role="alert" className="text-[11px] text-danger">
          {refusal}
        </span>
      )}
    </span>
  )
}
