/**
 * `QrCode` — renders a scannable QR code from an arbitrary string.
 *
 * Browser-pure: wraps `qrcode.react`'s synchronous SVG renderer.
 * The `qrcode` npm package is intentionally NOT used — it is a
 * CommonJS, Node-targeted library, and bundling it into ui-library
 * dragged `node:module` / `createRequire` into the browser output,
 * breaking every downstream browser build that consumes ui-library.
 *
 * Addon-agnostic — used by the generic device-export panel to render a
 * HAP `X-HM://…` setup URI, a pairing URL, or any other scannable
 * string an export addon surfaces via the `device-export` cap's
 * `setup.qr` field.
 */
import { useUiText } from '../contexts/ui-text'
import { type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { cn } from '../lib/cn'

const DEFAULT_SIZE = 192

export interface QrCodeProps {
  /** The string encoded into the QR. Empty/whitespace renders nothing. */
  readonly value: string
  /** Rendered width/height in CSS pixels. Defaults to 192. */
  readonly size?: number
  /** Extra classes merged onto the wrapper. */
  readonly className?: string
  /** Accessible label for the generated QR. */
  readonly alt?: string
}

export function QrCode({
  value,
  size = DEFAULT_SIZE,
  className,
  alt,
}: QrCodeProps): ReactElement | null {
  const t = useUiText()
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  return (
    <div className={cn('inline-flex rounded-md bg-white p-2', className)}>
      <QRCodeSVG
        value={trimmed}
        size={size}
        marginSize={1}
        title={alt ?? t('uiLibrary.qrCode.alt', 'QR code')}
      />
    </div>
  )
}
