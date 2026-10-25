import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Context,
  type JSX,
} from 'react'
import type { ReactNode } from 'react'
import type { ThemeMode, UseThemeModeReturn } from './types'

export const ThemeContext: Context<UseThemeModeReturn | null> =
  createContext<UseThemeModeReturn | null>(null)

interface ThemeProviderProps {
  children: ReactNode
  defaultMode?: ThemeMode
  storageKey?: string
}

const TOGGLE_ORDER: readonly ThemeMode[] = ['dark', 'light', 'system'] as const

function getSystemPreference(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getInitialMode(storageKey: string, defaultMode: ThemeMode): ThemeMode {
  if (typeof window === 'undefined') return defaultMode
  const stored = localStorage.getItem(storageKey)
  if (stored === 'dark' || stored === 'light' || stored === 'system') {
    return stored
  }
  return defaultMode
}

function resolveMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') return getSystemPreference()
  return mode
}

export function ThemeProvider({
  children,
  defaultMode = 'system',
  storageKey = 'camstack-theme-mode',
}: ThemeProviderProps): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(() => getInitialMode(storageKey, defaultMode))
  const [resolvedMode, setResolvedMode] = useState<'dark' | 'light'>(() => resolveMode(mode))

  const setMode = useCallback(
    (newMode: ThemeMode) => {
      setModeState(newMode)
      setResolvedMode(resolveMode(newMode))
      if (typeof window !== 'undefined') {
        localStorage.setItem(storageKey, newMode)
      }
    },
    [storageKey],
  )

  const toggleMode = useCallback(() => {
    const currentIndex = TOGGLE_ORDER.indexOf(mode)
    const nextIndex = (currentIndex + 1) % TOGGLE_ORDER.length
    setMode(TOGGLE_ORDER[nextIndex] ?? 'dark')
  }, [mode, setMode])

  // Apply CSS class on document.documentElement
  useEffect(() => {
    if (typeof document === 'undefined') return

    const root = document.documentElement
    root.classList.remove('dark', 'light')
    // Always apply the resolved class — even in 'system' mode, the CSS
    // variables need the .dark or .light class to activate
    root.classList.add(resolvedMode)
  }, [mode, resolvedMode])

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (typeof window === 'undefined' || mode !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      setResolvedMode(getSystemPreference())
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [mode])

  const value = useMemo<UseThemeModeReturn>(
    () => ({ mode, resolvedMode, setMode, toggleMode }),
    [mode, resolvedMode, setMode, toggleMode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
