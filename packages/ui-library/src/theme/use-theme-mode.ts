import { useContext } from 'react'
import { ThemeContext } from './theme-provider'
import type { UseThemeModeReturn } from './types'

export function useThemeMode(): UseThemeModeReturn {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useThemeMode must be used within a ThemeProvider')
  }
  return context
}
