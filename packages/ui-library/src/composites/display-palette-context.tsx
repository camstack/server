/**
 * The cluster palette, when a host has read `display-palette` (D939).
 * No provider, a pending read, or an unknown store all paint the bundled
 * CamStack preset. Only `ready` replaces it. Callers that must say the
 * store was unreadable read {@link useDisplayPaletteView}.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { bundledCamstack, type PaletteReady } from '@camstack/types'
import { getClassColor } from './detection-colors'

const BUNDLED = bundledCamstack()

export type DisplayPaletteView =
  | { readonly status: 'absent' }
  | { readonly status: 'pending' }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'ready'; readonly palette: PaletteReady }

const DisplayPaletteContext = createContext<DisplayPaletteView>({ status: 'absent' })

export interface DisplayPaletteProviderProps {
  readonly value: DisplayPaletteView
  readonly children: ReactNode
}

export function DisplayPaletteProvider({
  value,
  children,
}: DisplayPaletteProviderProps): ReactNode {
  return <DisplayPaletteContext.Provider value={value}>{children}</DisplayPaletteContext.Provider>
}

export function useDisplayPaletteView(): DisplayPaletteView {
  return useContext(DisplayPaletteContext)
}

export function useClassPainter(): (
  className: string,
  customColors?: Readonly<Record<string, string>>,
) => string {
  const view = useContext(DisplayPaletteContext)
  const palette = view.status === 'ready' ? view.palette : BUNDLED
  return (className, customColors) => getClassColor(className, customColors, palette)
}
