import type { ReactNode } from 'react'
export type LoginResult = { kind: 'ok' }
const user = {
  id: 'u-admin',
  username: 'admin',
  isAdmin: true,
  exp: 4102444800,
  scopes: [] as const,
}
const value = {
  user,
  loading: false,
  mustChangePassword: false,
  login: async () => ({ kind: 'ok' as const }),
  verifyTotp: async () => undefined,
  finalizePasskeyLogin: async () => undefined,
  logout: () => undefined,
  clearMustChangePassword: () => undefined,
}
export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
export function useAuth() {
  return value
}
