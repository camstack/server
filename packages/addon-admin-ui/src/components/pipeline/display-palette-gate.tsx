/**
 * Reads `display-palette` for the admin shell (D939). Pending stays pending.
 * An error or an `unknown` result is said out loud; painting falls back to
 * the bundled preset inside {@link useClassPainter}.
 */
import type { JSX, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DisplayPaletteProvider,
  useDisplayPaletteGetPalette,
  useDisplayPaletteView,
  type DisplayPaletteView,
} from '@camstack/ui-library'

export interface DisplayPaletteGateProps {
  readonly children: ReactNode
}

export function DisplayPaletteGate({ children }: DisplayPaletteGateProps): JSX.Element {
  const query = useDisplayPaletteGetPalette({})
  const value: DisplayPaletteView = query.isPending
    ? { status: 'pending' }
    : query.isError || query.data === undefined
      ? { status: 'unknown', reason: query.isError ? String(query.error) : 'no palette' }
      : query.data.status === 'unknown'
        ? { status: 'unknown', reason: query.data.reason }
        : { status: 'ready', palette: query.data }
  return <DisplayPaletteProvider value={value}>{children}</DisplayPaletteProvider>
}

/** One line when the store cannot be read. Pending renders nothing. */
export function DisplayPaletteNotice(): JSX.Element | null {
  const view = useDisplayPaletteView()
  const { t } = useTranslation()
  if (view.status !== 'unknown') return null
  return (
    <p role="status" className="shrink-0 px-4 py-1 text-xs text-warning">
      {t(
        'pipeline.palette.unknown',
        'The stored palette cannot be read ({{reason}}). Boxes use the bundled CamStack preset.',
        { reason: view.reason },
      )}
    </p>
  )
}
