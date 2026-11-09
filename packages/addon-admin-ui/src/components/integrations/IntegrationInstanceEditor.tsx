import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useSystem,
} from '@camstack/ui-library'

import { InstanceEditorDialog } from '../instances/InstanceEditorDialog'

interface IntegrationInstanceEditorProps {
  readonly addonId: string
  /** The instance (integration) id the page shows. */
  readonly integrationId: string
  readonly name: string
  readonly onClose: () => void
  /** The record changed: the page refreshes whatever it shows of it. */
  readonly onSaved: () => void
}

/**
 * Opens the shared `InstanceEditorDialog` on the instance a detail page shows. This component only
 * LOADS the two reads the dialog needs (`describe` and `getInstance`) and says so while they run or
 * when they fail; the form, the name, the test, the sign-in and the save are the dialog's, so an
 * integration is edited by the one editor everything else is (D1013).
 */
export function IntegrationInstanceEditor({
  addonId,
  integrationId,
  name,
  onClose,
  onSaved,
}: IntegrationInstanceEditorProps): ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  const describeQuery = useQuery({
    queryKey: ['integration-instance-describe', addonId],
    queryFn: () => system.trpcClient.integrationInstances.describe.query({ addonId }),
  })
  const instanceQuery = useQuery({
    queryKey: ['integration-instance', addonId, integrationId],
    queryFn: () =>
      system.trpcClient.integrationInstances.getInstance.query({ addonId, id: integrationId }),
  })

  if (describeQuery.isSuccess && instanceQuery.isSuccess && instanceQuery.data !== null) {
    return (
      <InstanceEditorDialog
        addonId={addonId}
        providerName={name}
        description={describeQuery.data}
        instance={instanceQuery.data}
        onClose={onClose}
        onSaved={() => onSaved()}
      />
    )
  }

  const failed =
    describeQuery.isError ||
    instanceQuery.isError ||
    (instanceQuery.isSuccess && !instanceQuery.data)
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('integrations.editConfig', { defaultValue: 'Edit configuration' })} — {name}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {failed ? (
            <p className="text-[11px] text-danger">
              {t('integrations.loadFailed', {
                defaultValue: 'Could not load this integration.',
              })}
            </p>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('integrations.loading', { defaultValue: 'Loading…' })}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
