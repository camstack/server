// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { ThemeProvider } from '../theme-provider'
import { useThemeMode } from '../use-theme-mode'
import type { ReactNode } from 'react'

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider defaultMode="dark">{children}</ThemeProvider>
}

describe('ThemeProvider + useThemeMode', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it('defaults to the provided defaultMode', () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper })
    expect(result.current.mode).toBe('dark')
    expect(result.current.resolvedMode).toBe('dark')
  })

  it('sets CSS class on document element', () => {
    renderHook(() => useThemeMode(), { wrapper })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setMode updates mode and CSS class', () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper })
    act(() => result.current.setMode('light'))
    expect(result.current.mode).toBe('light')
    expect(result.current.resolvedMode).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('persists mode to localStorage', () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper })
    act(() => result.current.setMode('light'))
    expect(localStorage.getItem('camstack-theme-mode')).toBe('light')
  })

  it('toggleMode cycles dark -> light -> system -> dark', () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper })
    expect(result.current.mode).toBe('dark')
    act(() => result.current.toggleMode())
    expect(result.current.mode).toBe('light')
    act(() => result.current.toggleMode())
    expect(result.current.mode).toBe('system')
    act(() => result.current.toggleMode())
    expect(result.current.mode).toBe('dark')
  })
})
