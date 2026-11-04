/**
 * `BrokerEditorDialog` is THE way a broker is created or edited from a caller that needs the
 * broker's id: the integration wizard's broker step, the picker's "Create new…", the Matter
 * device dialog. It is a thin wrapper over the instances editor (`InstanceEditorDialog`): every
 * provider that serves the `broker` cap also serves `integration-instances` over the same records
 * and ids, so there is ONE create / edit / sign-in dialog and no second form.
 *
 *   - create (`broker` omitted): the provider is the `addonId` given, else the one that serves
 *     `kind`; the instances editor asks for the kind itself when the provider has several;
 *   - edit (`broker` given): the stored record in the same editor.
 *
 * `onSaved(brokerId)` fires once the broker exists (created, edited or signed in); the caller
 * decides what the dialog's closing means. The dialog names no kind.
 */
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  useSystem,
} from '@camstack/ui-library'
import type { UnifiedBrokerInfo } from '@camstack/types'
import { InstanceEditorDialog } from '../instances/InstanceEditorDialog'
import { useBrokerKinds } from './broker-kinds'

export interface BrokerEditorDialogProps {
  /** Edit this broker; omit to create one. */
  readonly broker?: UnifiedBrokerInfo
  /** Create only this kind (a wizard that needs one specific kind). */
  readonly kind?: string
  /** Create only kinds this provider serves (a provider-scoped list). */
  readonly addonId?: string
  readonly onClose: () => void
  /** The broker exists: created, edited or signed in. */
  readonly onSaved: (brokerId: string) => void
}

function Placeholder({
  children,
  onClose,
}: {
  readonly children: ReactNode
  readonly onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>&nbsp;</DialogTitle>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function BrokerEditorDialog({
  broker,
  kind,
  addonId,
  onClose,
  onSaved,
}: BrokerEditorDialogProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const kinds = useBrokerKinds({
    ...(addonId !== undefined ? { addonId } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })
  const option = kinds.options.find((o) => o.addonId !== undefined)
  const ownerId = broker?.addonId ?? addonId ?? option?.addonId
  const providerName = option?.label ?? broker?.kind ?? ''

  const loaded = useQuery({
    queryKey: ['broker-editor-instance', ownerId, broker?.id ?? null],
    enabled: ownerId !== undefined,
    queryFn: async () => {
      const client = system.trpcClient.integrationInstances
      const description = await client.describe.query({ addonId: ownerId ?? '' })
      const instance =
        broker === undefined
          ? null
          : await client.getInstance.query({ addonId: ownerId ?? '', id: broker.id })
      return { description, instance }
    },
  })

  if (ownerId === undefined) {
    return (
      <Placeholder onClose={onClose}>
        {kinds.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ErrorBox message={t('brokers.editor.noProvider', 'No provider serves this kind.')} />
        )}
      </Placeholder>
    )
  }
  if (loaded.isError) {
    return (
      <Placeholder onClose={onClose}>
        <ErrorBox message={loaded.error.message} />
      </Placeholder>
    )
  }
  if (loaded.data === undefined) {
    return (
      <Placeholder onClose={onClose}>
        <Loader2 className="h-4 w-4 animate-spin" />
      </Placeholder>
    )
  }
  return (
    <InstanceEditorDialog
      addonId={ownerId}
      providerName={providerName}
      description={loaded.data.description}
      instance={loaded.data.instance}
      onClose={onClose}
      onSaved={(id) => {
        void queryClient.invalidateQueries()
        onSaved(id)
      }}
    />
  )
}
