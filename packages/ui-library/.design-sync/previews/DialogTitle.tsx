import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg" style={{ minHeight: 480 }}>
    {children}
  </div>
)

// DialogTitle is the dialog's <h2> heading. Shown in place inside an open
// dialog.
export const TitleInDialog = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>Edit motion zones — Backyard</DialogTitle>
          <DialogDescription>
            Draw the areas where detections should trigger recording.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded border border-border p-3 text-xs text-foreground-muted">
          2 zones · person, car · 1920×1080
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="primary" size="sm">
            Save zones
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
