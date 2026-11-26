/**
 * The `config` cardinality of the Customize catalog (D944): an extension whose
 * editor is a modal of its own. The catalog says WHICH capability is offered on
 * this device type; the registries below say which component edits it — an
 * EDITOR is the modal itself and opens straight from the row (the remote:
 * planning#464), a CARD is shown inside the generic row dialog. A catalog
 * entry with neither renders nothing (it never invents one).
 */
import { CAP_CUSTOMIZE_CATALOG, type DeviceInfo } from '@camstack/types'
import { useRemoteGetConfig } from '@camstack/ui-library'
import type { ComponentType, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FanPresetsExtensionCard } from '../../../fan-presets/FanPresetsExtensionCard'
import { RemoteConfigDialog } from '../../../remote/RemoteConfigDialog'
import { useConfigDraft } from './config-draft'

export interface ConfigCardProps {
  readonly device: DeviceInfo
}

export interface ConfigEditorProps extends ConfigCardProps {
  readonly onClose: () => void
}

/** The remote's modal: its confirm hands the configuration to the tab's draft, the tab's Save writes it. */
export function RemoteEditor({ device, onClose }: ConfigEditorProps): ReactNode {
  const { t } = useTranslation()
  const draft = useConfigDraft()
  const stored = useRemoteGetConfig({ deviceId: device.id })
  return (
    <RemoteConfigDialog
      device={device}
      open
      kept={draft?.remote ?? null}
      onKeep={(config) => {
        // The tab has no draft to keep it in: the dialog stays open and says so.
        if (draft === null) return t('customize.table.keepUnavailable')
        // A Keep that lands on what is stored is no edit: the tab stays clean.
        draft.setRemote(
          device,
          JSON.stringify(config) === JSON.stringify(stored.data) ? null : config,
        )
        return null
      }}
      onClose={onClose}
    />
  )
}

const CONFIG_EDITORS: Readonly<Record<string, ComponentType<ConfigEditorProps>>> = {
  remote: RemoteEditor,
}

/** The modal that edits this cap on its own, or null when the cap is a card. */
export function configEditorOf(cap: string): ComponentType<ConfigEditorProps> | null {
  return CONFIG_EDITORS[cap] ?? null
}

export interface ConfigCustomizeListProps extends ConfigCardProps {
  /** Render only this cap's editor (the Customize table opens one at a time). */
  readonly onlyCap?: string
}

const CONFIG_CARDS: Readonly<Record<string, ComponentType<ConfigCardProps>>> = {
  'fan-presets': FanPresetsExtensionCard,
}

/** The capabilities whose `config` target the catalog offers on this device type. */
export function configCardCaps(deviceType: string): readonly string[] {
  const caps: string[] = []
  for (const [cap, entry] of Object.entries(CAP_CUSTOMIZE_CATALOG)) {
    const offered = entry.targets.some(
      (target) =>
        target.cardinality === 'config' &&
        (target.deviceTypes as readonly string[]).includes(deviceType),
    )
    if (offered) caps.push(cap)
  }
  return caps
}

export function ConfigCustomizeList({ device, onlyCap }: ConfigCustomizeListProps): ReactNode {
  return configCardCaps(device.type).map((cap) => {
    if (onlyCap !== undefined && cap !== onlyCap) return null
    const Card = CONFIG_CARDS[cap]
    return Card === undefined ? null : <Card key={cap} device={device} />
  })
}
