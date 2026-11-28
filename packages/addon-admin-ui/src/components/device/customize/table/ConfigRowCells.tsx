/**
 * The Value and Source cells of an extension row. Each extension keeps its
 * own configuration; the cells read the same query its card reads, so the row
 * shows what is configured and where it comes from — or says the read is
 * unanswered or failed (D315, D393), never a bare "configured" badge.
 */
import type { DeviceInfo } from '@dominevo/types'
import { useFanPresetsGetPresets, useRemoteGetConfig, useTemplateList } from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigDraft } from '../config/config-draft'
import type { CustomizeRowSpec } from './customize-rows'

export interface ConfigRowProps {
  readonly spec: CustomizeRowSpec
  readonly device: DeviceInfo
}

function Text({ children, muted }: { readonly children: ReactNode; readonly muted?: boolean }) {
  return (
    <span className={`text-xs ${muted === true ? 'text-foreground-subtle' : 'text-foreground'}`}>
      {children}
    </span>
  )
}

function Checking(): ReactNode {
  const { t } = useTranslation()
  return (
    <span role="status" className="text-xs text-foreground-subtle">
      {t('customize.event.checking')}
    </span>
  )
}

function Unread({ reason }: { readonly reason: string | null }): ReactNode {
  const { t } = useTranslation()
  return (
    <span role="alert" className="text-xs text-warning" title={reason ?? undefined}>
      {t('customize.table.unknown')}
    </span>
  )
}

export function ConfigValueCell(props: ConfigRowProps): ReactNode {
  switch (props.spec.cap) {
    case 'remote':
      return <RemoteValue device={props.device} />
    case 'fan-presets':
      return <FanValue device={props.device} />
    default:
      return <Unread reason={null} />
  }
}

export function ConfigSourceCell(props: ConfigRowProps): ReactNode {
  switch (props.spec.cap) {
    case 'remote':
      return <RemoteSource device={props.device} />
    case 'fan-presets':
      return <FanSource device={props.device} />
    default:
      return <Unread reason={null} />
  }
}

interface DeviceProps {
  readonly device: DeviceInfo
}

function RemoteValue({ device }: DeviceProps): ReactNode {
  const { t } = useTranslation()
  const config = useRemoteGetConfig({ deviceId: device.id })
  const kept = useConfigDraft()?.remote ?? null
  if (config.status === 'error') return <Unread reason={config.error?.message ?? null} />
  if (config.data === undefined) return <Checking />
  const shown = kept ?? config.data
  const count = Object.keys(shown.bindings).length
  if (count === 0 && shown.layoutTemplateId == null) {
    return <Text muted>{t('customize.table.notConfigured')}</Text>
  }
  return <Text>{t('customize.table.commandsCount', { count })}</Text>
}

/** The layout template the remote is drawn from. */
function RemoteSource({ device }: DeviceProps): ReactNode {
  const { t } = useTranslation()
  const config = useRemoteGetConfig({ deviceId: device.id })
  const templates = useTemplateList({ kind: 'remote' })
  const kept = useConfigDraft()?.remote ?? null
  if (config.status === 'error') return <Unread reason={config.error?.message ?? null} />
  if (config.data === undefined) return <Checking />
  const id = (kept ?? config.data).layoutTemplateId
  if (id == null) return <Text muted>{t('remote.dialog.noTemplate')}</Text>
  if (templates.status === 'error') return <Unread reason={templates.error?.message ?? null} />
  const name = (templates.data ?? []).find((row) => row.id === id)?.name ?? null
  if (templates.data === undefined) return <Checking />
  return name === null ? <Unread reason={null} /> : <Text>{name}</Text>
}

function FanValue({ device }: DeviceProps): ReactNode {
  const { t } = useTranslation()
  const presets = useFanPresetsGetPresets({ deviceId: device.id })
  const kept = useConfigDraft()?.fanPresets ?? null
  if (presets.status === 'error') return <Unread reason={presets.error?.message ?? null} />
  if (presets.data === undefined) return <Checking />
  const shown = kept ?? presets.data
  if (shown.length === 0) return <Text muted>{t('customize.table.noPresets')}</Text>
  return <Text>{t('customize.table.presetsCount', { count: shown.length })}</Text>
}

/**
 * The device the presets set: the fan itself, through its own fan-control
 * methods (D1034). A field linked in Customize is forwarded to its link there.
 */
function FanSource({ device }: DeviceProps): ReactNode {
  const { t } = useTranslation()
  const presets = useFanPresetsGetPresets({ deviceId: device.id })
  const kept = useConfigDraft()?.fanPresets ?? null
  if (presets.status === 'error') return <Unread reason={presets.error?.message ?? null} />
  if (presets.data === undefined) return <Checking />
  if ((kept ?? presets.data).length === 0) return <Text muted>{t('customize.table.noSource')}</Text>
  return <Text>{device.name}</Text>
}
