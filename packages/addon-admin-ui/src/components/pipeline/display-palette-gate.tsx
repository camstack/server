/**
 * Reads `display-palette` for the admin shell (D939). Pending stays pending.
 * A hub that never answered, or answered `unknown`, is said out loud; painting
 * falls back to the bundled preset inside {@link useClassPainter}. A failed
 * refetch keeps the palette the hub last answered.
 */
import type { JSX, ReactNode } from 'react'
import type { PaletteResult } from '@camstack/types'
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
  return <DisplayPaletteProvider value={paletteViewOf(query)}>{children}</DisplayPaletteProvider>
}

/** The parts of the palette query the view is decided from. */
export interface PaletteQueryState {
  readonly isPending: boolean
  readonly isError: boolean
  readonly error: unknown
  readonly data: PaletteResult | undefined
}

/**
 * The last palette the hub ANSWERED wins: a failed background refetch (a
 * window-focus refresh while the socket reconnects) keeps it. Only a query
 * that never answered reads as unknown.
 */
export function paletteViewOf(query: PaletteQueryState): DisplayPaletteView {
  if (query.data !== undefined) {
    return query.data.status === 'unknown'
      ? { status: 'unknown', reason: query.data.reason }
      : { status: 'ready', palette: query.data }
  }
  if (query.isPending) return { status: 'pending' }
  return { status: 'unknown', reason: query.isError ? String(query.error) : 'no palette' }
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
