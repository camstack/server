/**
 * The settings dialog of a provider that keeps no records (a fixed row): the provider's
 * cluster-scoped global settings. The table imports only this component, so how a provider's
 * settings are drawn changes in this file and never in the table.
 */
import type { ReactElement } from 'react'
import { AddonSettingsModal } from '../settings/AddonSettingsModal'

export interface FixedRowSettingsDialogProps {
  readonly addonId: string
  readonly title: string
  readonly onClose: () => void
}

export function FixedRowSettingsDialog({
  addonId,
  title,
  onClose,
}: FixedRowSettingsDialogProps): ReactElement {
  return (
    <AddonSettingsModal addonId={addonId} title={title} fieldScope="cluster" onClose={onClose} />
  )
}
