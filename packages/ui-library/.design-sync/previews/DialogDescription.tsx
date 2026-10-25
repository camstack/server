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

// DialogDescription is the muted supporting paragraph under the title. Shown
// in place inside an open dialog.
export const DescriptionInDialog = () => (
  <Frame>
    <Dialog open onOpenChange={() => {}}>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>Disable recording</DialogTitle>
          <DialogDescription>
            “Driveway” will stop recording continuously. Motion-triggered clips from ONVIF are
            unaffected, and existing recordings on the hub are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
          <Button variant="danger" size="sm">
            Disable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Frame>
)
