import type { ReactNode } from 'react'
import {
  Dialog,
  DialogTrigger,
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

// DialogTrigger only renders meaningfully inside <Dialog>. Shown with the
// dialog forced OPEN so both the trigger button and the resulting content
// are visible together.
export const TriggerWithOpenDialog = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogTrigger className="rounded-md border border-border bg-background-elevated px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface">
        Remove camera…
      </DialogTrigger>
      <DialogContent width="sm">
        <DialogHeader>
          <DialogTitle>Delete camera</DialogTitle>
          <DialogDescription>
            Remove “Garage” (Hikvision) from this hub? Recordings are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="danger" size="sm">
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
