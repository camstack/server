/**
 * Customize (D676) — the device page's view of its ONE customization block
 * (D663). It stores nothing: the assignment cards merge a feature into the
 * block, identity writes the authorities that already exist, links are the
 * D648 slot. What it claims about the block is one of five answered states
 * (D315). Order: identity, status, the one table, then a camera's linked-devices table.
 */
import {
  COMPOSER_ADDON_ID,
  type CompositionSourceRef,
  type DeviceInfo,
  DeviceType,
} from '@camstack/types'
import {
  Badge,
  ErrorBox,
  useCapabilityPresence,
  useDeviceManagerGetDevice,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentFacts } from './assignment-availability'
import { type CustomizationState, currentComposition } from './customization-read'
import { IdentityRow } from './IdentityRow'
import { QuickDetailSaveProvider } from '../quick-detail-save'
import { CustomizeTable } from './table/CustomizeTable'
import { LinkedDevicesTable } from './kinds/LinkedDevicesTable'
import { useCustomization } from './use-customization'
import { useCameraSensors } from './use-camera-sensors-presence'
import { useCustomizeFacts } from './use-customize-facts'
import { useDefaultConsumables } from './use-default-consumables'
import { ComposedCustomizeBody } from './ComposedCustomizeBody'

export interface CustomizeTabProps {
  readonly deviceId: number
}

export function CustomizeTab({ deviceId }: CustomizeTabProps): ReactNode {
  const { t } = useTranslation()
  const deviceRead = useDeviceManagerGetDevice({ deviceId })
  const device = deviceRead.data
  if (device === undefined || device === null) {
    if (deviceRead.status === 'error') {
      return (
        <ErrorBox
          title={t('customize.deviceUnreadable')}
          message={deviceRead.error?.message ?? ''}
          onRetry={() => void deviceRead.refetch()}
        />
      )
    }
    if (device === null) {
      return (
        <p role="status" className="text-xs text-foreground-subtle">
          {t('customize.noSuchDevice', { deviceId })}
        </p>
      )
    }
    return (
      <p role="status" className="text-xs text-foreground-subtle">
        {t('customize.loadingDevice')}
      </p>
    )
  }
  const body =
    device.addonId === COMPOSER_ADDON_ID ? (
      <ComposedCustomizeBody device={device} />
    ) : (
      <CustomizeBody
        device={device}
        target={{ addonId: device.addonId, stableId: device.stableId }}
      />
    )
  return (
    <QuickDetailSaveProvider
      deviceId={device.id}
      seed={{
        name: device.name,
        location: device.location ?? '',
        role: device.role ?? null,
        display: device.display,
      }}
    >
      {body}
    </QuickDetailSaveProvider>
  )
}

interface CustomizeBodyProps {
  readonly device: DeviceInfo
  readonly target: CompositionSourceRef
}

function CustomizeBody({ device, target }: CustomizeBodyProps): ReactNode {
  const handle = useCustomization(target)
  const composer = useCapabilityPresence('composer')
  const { t } = useTranslation()
  const cameraSensors = useCameraSensors(device.id, device.type === DeviceType.Camera)
  const facts = useCustomizeFacts(device, currentComposition(handle.state))
  const defaultConsumables = useDefaultConsumables(device.id, facts.nativeCaps, facts.wireable)
  const assignmentFacts: AssignmentFacts = {
    deviceType: device.type,
    composable: facts.composable,
    nativeCaps: facts.nativeCaps,
    cameraSensors: cameraSensors.presence,
  }
  return (
    <div className="flex flex-col gap-3">
      <IdentityRow device={device} />
      {composer === 'absent' && (
        <p role="alert" className="text-xs text-warning">
          {t('customize.composerAbsent')}
        </p>
      )}
      {handle.state.kind !== 'none' && <CustomizationStatus state={handle.state} />}
      <CustomizeTable
        device={device}
        handle={handle}
        facts={assignmentFacts}
        sensors={cameraSensors}
        defaults={defaultConsumables}
      />
      {device.type === DeviceType.Camera && <LinkedDevicesTable device={device} />}
    </div>
  )
}

interface CustomizationStatusProps {
  readonly state: CustomizationState
}

function CustomizationStatus({ state }: CustomizationStatusProps): ReactNode {
  const { t } = useTranslation()
  switch (state.kind) {
    case 'pending':
      return (
        <p role="status" className="text-xs text-foreground-subtle">
          {t('customize.status.pending')}
        </p>
      )
    case 'unknown':
      return <ErrorBox title={t('customize.status.unknownTitle')} message={state.reason} />
    case 'not-loaded':
      return (
        <p role="status" className="text-xs text-foreground-subtle">
          {t('customize.status.notLoaded', { reason: state.reason })}
        </p>
      )
    case 'none':
      return null
    case 'present': {
      const block = state.view.block
      const variant =
        block.status === 'running' ? 'success' : block.status === 'failed' ? 'danger' : 'warning'
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={variant}>{t(`customize.blockStatus.${block.status}`)}</Badge>
          {!block.enabled && <Badge variant="default">{t('customize.status.off')}</Badge>}
          {block.lastError !== undefined && (
            <span className="text-[11px] text-foreground-muted break-words">{block.lastError}</span>
          )}
          {state.view.state.kind === 'unreachable' && (
            <span className="text-[11px] text-warning">
              {t('customize.status.composerUnreachable', {
                reason: state.view.state.error,
              })}
            </span>
          )}
        </div>
      )
    }
  }
}
