/**
 * `InstanceCreateDialog` is THE way an instance is created from a caller that needs its id: a
 * picker's "Create new…", the integration wizard's broker step, the Matter device dialog. It is a
 * thin wrapper over `InstanceEditorDialog` narrowed to the kinds of one function (D1013), so there
 * is ONE create / sign-in dialog and no second form.
 *
 *   - the provider is the `addonId` given, else the one that serves `kind` for `functionCap`;
 *   - the editor asks for the kind itself when the section has several.
 *
 * `onSaved(id)` fires once the instance exists (created or signed in). The dialog names no kind.
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
import { InstanceEditorDialog } from './InstanceEditorDialog'
import { sectionDescription, type TypedIdRuleFor } from './instances-model'
import { useInstanceKinds } from './instance-kinds'

export interface InstanceCreateDialogProps {
  readonly functionCap: string
  /** Create only this registry kind (a wizard that needs one specific kind). */
  readonly kind?: string
  /** Create only kinds this provider serves. */
  readonly addonId?: string
  readonly onClose: () => void
  /** The instance exists: created or signed in. */
  readonly onSaved: (id: string) => void
  /** The kinds whose id the operator types (see `InstanceEditorDialog`). */
  readonly typedId?: TypedIdRuleFor
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

export function InstanceCreateDialog({
  functionCap,
  kind,
  addonId,
  onClose,
  onSaved,
  typedId,
}: InstanceCreateDialogProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const kinds = useInstanceKinds({
    functionCap,
    ...(addonId !== undefined ? { addonId } : {}),
    ...(kind !== undefined ? { kind } : {}),
  })
  const option = kinds.options[0]
  const ownerId = addonId ?? option?.addonId

  const loaded = useQuery({
    queryKey: ['instance-create-description', ownerId, functionCap, option?.kind ?? null],
    enabled: ownerId !== undefined,
    queryFn: async () => {
      const full = await system.trpcClient.integrationInstances.describe.query({
        addonId: ownerId ?? '',
      })
      return sectionDescription(full, functionCap, option?.kind)
    },
  })

  if (ownerId === undefined || loaded.data === null) {
    return (
      <Placeholder onClose={onClose}>
        {ownerId === undefined && kinds.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ErrorBox message={t('brokers.editor.noProvider')} />
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
      providerName={option?.label ?? ''}
      description={loaded.data}
      instance={null}
      onClose={onClose}
      {...(typedId !== undefined ? { typedId } : {})}
      onSaved={(id) => {
        void queryClient.invalidateQueries()
        onSaved(id)
      }}
    />
  )
}
