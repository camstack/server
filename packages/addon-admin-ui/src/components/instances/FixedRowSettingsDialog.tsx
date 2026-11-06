/**
 * The settings dialog of a provider that keeps no records (a fixed row): its cluster-scoped
 * global settings, drawn by the library's `AddonGlobalSettingsForm`. The table names no
 * settings panel of its own, so a later change to how an addon's settings are read lands in
 * the form, never here.
 */
import {
  AddonGlobalSettingsForm,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useSystem,
} from '@camstack/ui-library'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import type { ReactElement } from 'react'
import { filterSchemaByFieldScope } from '../../lib/settings-field-scope'

/** A fixed row is one thing for the whole cluster: it never shows a per-node field. */
function clusterOnly(schema: ConfigUISchemaWithValues): ConfigUISchemaWithValues {
  return filterSchemaByFieldScope(schema, 'cluster')
}

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
  const system = useSystem()
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" className="md:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <AddonGlobalSettingsForm
            trpc={system.trpcClient}
            addonId={addonId}
            nodeId="hub"
            title={title}
            bare
            narrowSchema={clusterOnly}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
