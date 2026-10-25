/**
 * "How many devices this person will see" — rendered from the SERVER's
 * resolution of the draft (`auth.previewScope`), never from a client-side
 * reading of the same lists. The preview runs the identical
 * `summarizeEffectiveScope` call `auth.me` runs against the identical fleet,
 * so the number here is the number enforcement will produce.
 */
import type { EffectiveScope, UserScope } from '@camstack/types'
import { useDeviceManagerListAll, useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Eye, Loader2, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface RolePreviewProps {
  readonly scopes: readonly UserScope[]
  /**
   * Set when the draft cannot be saved yet. The preview is SUPPRESSED rather
   * than shown stale: a number left over from the previous edit is the one
   * thing this line must never show.
   */
  readonly invalidReason: string | null
}

export function RolePreview({ scopes, invalidReason }: RolePreviewProps): React.ReactElement {
  const { t } = useTranslation()
  const system = useSystem()
  // `auth.previewScope` is a CORE router method — no generated cap hook. The
  // key is structural, so only a real content change refetches.
  const preview = useQuery<EffectiveScope>({
    queryKey: ['auth', 'previewScope', scopes, false] as const,
    enabled: invalidReason === null,
    queryFn: () =>
      system.trpcClient.auth.previewScope.query({
        scopes: [...scopes],
        isAdmin: false,
      }),
  })
  // The denominator ("5 of 12") comes from the same `listAll` the pickers
  // read, so the two halves of the panel cannot disagree about the fleet.
  const { data: devices } = useDeviceManagerListAll({ projection: 'slim' })
  const fleetTotal = devices?.length ?? null

  if (invalidReason !== null) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-warning" data-testid="role-preview">
        <ShieldAlert className="h-3 w-3 shrink-0" />
        {invalidReason}
      </p>
    )
  }

  if (preview.isLoading) {
    return (
      <p
        className="flex items-center gap-1.5 text-[11px] text-foreground-subtle"
        data-testid="role-preview"
      >
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        {t('users.rolePreview.resolving')}
      </p>
    )
  }

  if (preview.isError || !preview.data) {
    // Unreadable is reported as unreadable — zeros would claim "sees nothing".
    return (
      <p className="text-[11px] text-danger" data-testid="role-preview">
        {t('users.rolePreview.couldNotResolve')}
      </p>
    )
  }

  const count = preview.data.viewableDeviceCount
  const text = preview.data.device.view.all
    ? t('users.rolePreview.everyDevice', { count })
    : fleetTotal === null
      ? t('users.rolePreview.devicesVisible', { count })
      : t('users.rolePreview.devicesVisibleOf', { count, total: fleetTotal })

  return (
    <p
      className={`flex items-center gap-1.5 text-[11px] ${count === 0 ? 'text-warning' : 'text-foreground'}`}
      data-testid="role-preview"
    >
      {count === 0 ? (
        <ShieldAlert className="h-3 w-3 shrink-0" />
      ) : (
        <Eye className="h-3 w-3 shrink-0 text-foreground-subtle" />
      )}
      {count === 0 ? t('users.rolePreview.noDevice') : text}
    </p>
  )
}
