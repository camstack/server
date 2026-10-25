import type { ReactNode } from 'react'
import { QrCode } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const HomeKitPairing = () => (
  <Frame>
    <div className="flex flex-col items-center gap-2">
      <QrCode value="X-HM://0023ABCDEFG8745" alt="HomeKit setup code" />
      <span className="text-xs text-foreground-subtle">Scan in the Home app</span>
    </div>
  </Frame>
)

export const PairingUrl = () => (
  <Frame>
    <QrCode value="https://camstack.local/pair?token=int_0001&exp=900" size={160} />
  </Frame>
)

export const SmallExport = () => (
  <Frame>
    <div className="flex items-center gap-3 rounded-lg bg-surface border border-border p-3">
      <QrCode value="X-HM://0024ZZYYXXW1122" size={96} alt="Front Door pairing" />
      <div className="flex flex-col">
        <span className="text-sm text-foreground">Front Door</span>
        <span className="text-xs text-foreground-subtle">HAP setup · 8745-0231</span>
      </div>
    </div>
  </Frame>
)
