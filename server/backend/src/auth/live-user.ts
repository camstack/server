/**
 * "Is this user id a user right now?" — asked by the surfaces that turn a
 * person's login session into something longer-lived (the OAuth consent page,
 * `/api/embed-auth`). A session JWT outlives a deleted account only by its
 * remaining lifetime, and an empty or unknown `userId` names nobody: both are
 * refused there (security review 2026-10-21).
 */
import type { IUserManagementProvider } from '@camstack/types'

export interface LiveUserRegistry {
  getSingleton<T>(capability: string): T | null | undefined
}

/** A check bound to `registry`'s `user-management` provider. Unreadable ⇒ `false` (fail closed). */
export function liveUserCheck(registry: LiveUserRegistry): (userId: string) => Promise<boolean> {
  return async (userId) => {
    if (userId === '') return false
    const users = registry.getSingleton<IUserManagementProvider>('user-management')
    if (users === null || users === undefined) return false
    try {
      return (await users.listUsers()).some((user) => user.id === userId)
    } catch {
      return false
    }
  }
}
