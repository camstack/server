/**
 * Fixture page for the shared Save / Discard bar inside a modal. Not an admin
 * route: `ui:shots` mounts it when the path is `/form-save-bar-preview`. The
 * body is tall on purpose so the sticky bar sits over scrolled content, which
 * is where a see-through background shows.
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ThemeProvider,
} from '@camstack/ui-library'
import type { ReactElement } from 'react'
import { FormSaveBar } from '../../../../packages/addon-admin-ui/src/components/form-builder/FormSaveBar'

const ROWS = Array.from({ length: 24 }, (_, i) => `Setting ${String(i + 1)}`)

export function FormSaveBarPreview(): ReactElement {
  return (
    <ThemeProvider>
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
          <DialogHeader>
            <DialogTitle>Addon settings</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-3">
              {ROWS.map((row) => (
                <div
                  key={row}
                  className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
                >
                  {row}
                </div>
              ))}
              <FormSaveBar pendingCount={3} onSave={() => undefined} onDiscard={() => undefined} />
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </ThemeProvider>
  )
}
