/**
 * The editor of a Customize row that is not a single scalar link — an event,
 * a keyed list or an extension. Each already has its own editor; this opens it
 * on its own, so the table lists the row and the existing card does the work.
 */
import type { DeviceInfo } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentFacts } from '../assignment-availability'
import { ConfigCustomizeList } from '../config/ConfigCustomizeList'
import { EventCustomizeList } from '../event/EventCustomizeList'
import { KeyedArrayCustomizeList } from '../keyed/KeyedArrayCard'
import type { Known } from '../known'
import type { DefaultConsumable } from '../default-consumables'
import type { CameraSensorsRead } from '../use-camera-sensors-presence'
import type { CustomizationHandle } from '../use-customization'
import type { CustomizeRowSpec } from './customize-rows'

export interface ManagedRowDialogProps {
  readonly spec: CustomizeRowSpec
  readonly title: string
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly facts: AssignmentFacts
  readonly sensors: CameraSensorsRead
  readonly defaults: Known<readonly DefaultConsumable[]>
  readonly onClose: () => void
}

export function ManagedRowDialog(props: ManagedRowDialogProps): ReactNode {
  const { t } = useTranslation()
  const { spec, device, handle } = props
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body" aria-label={props.title}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          {spec.kind === 'event' && (
            <EventCustomizeList
              device={device}
              handle={handle}
              facts={props.facts}
              sensors={props.sensors}
              onlyCap={spec.cap}
            />
          )}
          {spec.kind === 'keyed' && (
            <KeyedArrayCustomizeList
              device={device}
              handle={handle}
              facts={props.facts}
              defaults={props.defaults}
              onlyCap={spec.cap}
            />
          )}
          {spec.kind === 'config' && <ConfigCustomizeList device={device} onlyCap={spec.cap} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            {t('customize.table.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
