/**
 * Lightweight inline QR-code renderer for `otpauth://` URLs.
 *
 * We deliberately don't pull a heavyweight `qrcode.react` dep — TOTP
 * URLs are short (~200 chars), well within the range of a simple
 * QR generation. This implementation uses the `qrcode` library
 * (already a transitive dep) to compute the matrix, then renders it
 * as inline SVG so styling and high-DPI rendering work out of the box.
 *
 * Falls back to a "scan unavailable" message if the QR library is
 * missing; the secret string in the parent modal is the manual
 * entry path.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

interface TotpQrCodeProps {
  readonly value: string
  readonly size?: number
}

interface QrMatrix {
  modules: { size: number; data: Uint8Array }
}

export function TotpQrCode({ value, size = 192 }: TotpQrCodeProps) {
  const { t } = useTranslation()
  const [matrix, setMatrix] = useState<QrMatrix | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Dynamic import keeps the QR library out of the critical-path
    // bundle for the rest of admin-ui. Operators who never open the
    // TOTP modal pay zero cost.
    void import('qrcode')
      .then(async (mod) => {
        if (cancelled) return
        // `create()` produces the bit matrix without the rendering pass.
        // Cast through unknown — the lib's TS types vary by version.
        const create = (
          mod as {
            create: (text: string, opts: { errorCorrectionLevel: string }) => QrMatrix
          }
        ).create
        if (typeof create !== 'function') {
          setError('qrcode.create() unavailable in installed version')
          return
        }
        try {
          const m = create(value, { errorCorrectionLevel: 'M' })
          if (!cancelled) setMatrix(m)
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : 'QR generation failed')
        }
      })
      .catch(() => {
        if (!cancelled) setError('qrcode library not installed')
      })
    return () => {
      cancelled = true
    }
  }, [value])

  if (error) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-foreground-subtle text-center p-4"
        style={{ width: size, height: size }}
      >
        {t(
          'users.totpQrCode.qrRenderingUnavailableUseThe',
          'QR rendering unavailable — use the secret below.',
        )}
      </div>
    )
  }

  if (!matrix) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-foreground-subtle animate-pulse"
        style={{ width: size, height: size }}
      >
        {t('users.totpQrCode.generating', 'Generating…')}
      </div>
    )
  }

  const n = matrix.modules.size
  const cell = size / n
  const rects: ReactElement[] = []
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const bit = matrix.modules.data[y * n + x]
      if (bit) {
        rects.push(
          <rect
            key={`${x}-${y}`}
            x={x * cell}
            y={y * cell}
            width={cell}
            height={cell}
            fill="currentColor"
          />,
        )
      }
    }
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="text-black">
      <rect x={0} y={0} width={size} height={size} fill="white" />
      {rects}
    </svg>
  )
}
