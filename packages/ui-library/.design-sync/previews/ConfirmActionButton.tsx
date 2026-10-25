import type { ReactNode } from 'react'
import { ConfirmActionButton } from '@camstack/ui-library'
import { RotateCw, RefreshCw, Trash2 } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const reboot = async () => {
  await new Promise((r) => setTimeout(r, 300))
}

export const Hero = () => (
  <Frame>
    <ConfirmActionButton
      label="Reboot device"
      icon={RotateCw}
      title="Reboot Front Door?"
      description="The camera will be unreachable for ~30 seconds while it restarts."
      confirmLabel="Reboot now"
      action={reboot}
    />
  </Frame>
)

export const Variants = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <ConfirmActionButton
        label="Restart addon"
        icon={RefreshCw}
        triggerVariant="secondary"
        action={reboot}
      />
      <ConfirmActionButton
        label="Reboot"
        icon={RotateCw}
        triggerVariant="outline"
        action={reboot}
      />
      <ConfirmActionButton
        label="Delete camera"
        icon={Trash2}
        triggerVariant="danger"
        confirmVariant="danger"
        action={reboot}
      />
    </div>
  </Frame>
)

export const Sizes = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <ConfirmActionButton label="Reset" size="sm" action={reboot} />
      <ConfirmActionButton label="Reset" size="md" action={reboot} />
      <ConfirmActionButton label="Reset" size="lg" action={reboot} />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <ConfirmActionButton label="Regenerate token" icon={RefreshCw} disabled action={reboot} />
  </Frame>
)
