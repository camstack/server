export interface CamStackColorTokens {
  primary: string
  primaryForeground: string
  background: string
  backgroundElevated: string
  surface: string
  surfaceHover: string
  border: string
  borderSubtle: string
  foreground: string
  foregroundMuted: string
  foregroundSubtle: string
  foregroundDisabled: string
  success: string
  warning: string
  danger: string
  info: string
  successFill: string
  successOn: string
  warningFill: string
  warningOn: string
  dangerFill: string
  dangerOn: string
  infoFill: string
  infoOn: string
  primaryFill: string
  primaryOn: string
  neutralFill: string
  neutralOn: string
  provider: {
    onvif: string
    hikvision: string
    reolink: string
    homeAssistant: string
    rtsp: string
  }
}

export interface CamStackTheme {
  colors: {
    dark: CamStackColorTokens
    light: CamStackColorTokens
  }
  spacing: {
    xs: number
    sm: number
    md: number
    lg: number
    xl: number
    '2xl': number
    '3xl': number
  }
  radius: {
    sm: number
    md: number
    lg: number
    xl: number
  }
  typography: {
    fontFamily: string
    sizes: {
      xs: { fontSize: number; lineHeight: number }
      sm: { fontSize: number; lineHeight: number }
      base: { fontSize: number; lineHeight: number }
      lg: { fontSize: number; lineHeight: number }
      xl: { fontSize: number; lineHeight: number }
      '2xl': { fontSize: number; lineHeight: number }
      '3xl': { fontSize: number; lineHeight: number }
    }
    weights: {
      regular: number
      medium: number
      semibold: number
      bold: number
    }
  }
  table: {
    rowHeight: number
    headerHeight: number
    cellPaddingX: number
    cellPaddingY: number
  }
  sidebar: {
    width: number
    itemHeight: number
    iconSize: number
  }
}

export type ThemeMode = 'dark' | 'light' | 'system'

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export interface UseThemeModeReturn {
  mode: ThemeMode
  resolvedMode: 'dark' | 'light'
  setMode: (mode: ThemeMode) => void
  toggleMode: () => void
}
