import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

/**
 * A callback that drops every cached addon-settings read. A form that saves through the scoped
 * client (not a query hook) calls it, so the other surfaces over the same addon refetch.
 */
export function useInvalidateAddonSettings(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [['addonSettings']] })
  }, [queryClient])
}
