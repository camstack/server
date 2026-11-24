/**
 * The remove action of a row a device LINK added (D1063, e.g. a PoE power
 * source). Removing the feature alone would come back at the next pass, so the
 * action undoes the LINK itself (`deviceManager.unlinkIdentity`): the link
 * becomes `dismissed` and every feature it stamped is taken back. The confirm
 * names the device and each of those features.
 */
import type { CompositionFieldsFeature, DeviceInfo } from '@camstack/types'
import {
  IconButton,
  useDeviceManagerGetDevice,
  useDeviceManagerListIdentityLinks,
  useDeviceManagerUnlinkIdentity,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Unlink } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { requireDecided } from '../../overview-adapters/IdentityLinksBlock'
import { currentComposition } from '../customization-read'
import { useConfirmRemove } from '../use-confirm-remove'
import type { CustomizationHandle } from '../use-customization'

export interface LinkUnlinkButtonProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly linkId: string
  readonly testId: string
  readonly onError: (reason: string | null) => void
}

function stampedBy(
  handle: CustomizationHandle,
  linkId: string,
): readonly CompositionFieldsFeature[] {
  const current = currentComposition(handle.state)
  if (current === null) return []
  return current.features.filter(
    (f): f is CompositionFieldsFeature => f.kind === 'fields' && f.contributedBy?.linkId === linkId,
  )
}

export function LinkUnlinkButton(props: LinkUnlinkButtonProps): ReactNode {
  const { t } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const queryClient = useQueryClient()
  const links = useDeviceManagerListIdentityLinks({ deviceId: props.device.id })
  const unlink = useDeviceManagerUnlinkIdentity()
  const link =
    links.data?.status === 'answered'
      ? links.data.links.find((l) => l.id === props.linkId)
      : undefined
  const other = link === undefined ? null : link.a.deviceId === props.device.id ? link.b : link.a
  const otherDevice = useDeviceManagerGetDevice(
    { deviceId: other?.deviceId ?? 0 },
    { enabled: other !== null },
  )
  // The link is read before it can be undone: an unread one offers nothing to click (D315).
  const ready = link !== undefined && link.state === 'linked'
  const deviceName = otherDevice.data?.name ?? (other === null ? '' : `#${String(other.deviceId)}`)
  const features = stampedBy(props.handle, props.linkId)
    .map((f) => t(`customize.scalar.caps.${f.cap}`, f.cap))
    .join(', ')
  return (
    <IconButton
      variant="ghost"
      size="sm"
      icon={Unlink}
      aria-label={`${t('customize.table.unlink', { device: deviceName })}`}
      data-testid={props.testId}
      disabled={!ready || props.handle.saving || unlink.isPending}
      onClick={() => {
        void (async () => {
          const what = t('customize.table.unlinkWhat', { device: deviceName, features })
          if (!(await confirmRemove(what, false))) return
          try {
            requireDecided(await unlink.mutateAsync({ linkId: props.linkId }))
            await queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
            await queryClient.invalidateQueries({ queryKey: [['coreBlocks']] })
            props.onError(null)
          } catch (err: unknown) {
            props.onError(err instanceof Error ? err.message : String(err))
          }
        })()
      }}
    />
  )
}
