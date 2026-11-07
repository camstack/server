/**
 * AI -> Defaults: WHICH profile answers when a caller names none. The profiles are the `llm`
 * instances of the one instance model (`useInstancesOfCap`).
 */
import type { LlmDefault } from '@camstack/types'
import {
  Label,
  SECTION_BODY,
  SectionCard,
  Select,
  useInstancesOfCap,
  useSystem,
} from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  DEFAULTS_KEY,
  DEFAULT_PURPOSES,
  profileModel,
  profileSupportsVision,
} from './ai-page.helpers'

/**
 * WHICH profile answers when a caller names none.
 *
 * `getDefaults`/`setDefault` shipped with the cap and had no surface: the
 * confirm gate, the scene monitors and every future consumer resolve through
 * this chain, and the only way to set it was a hand-written tRPC call.
 *
 * A default naming a DISABLED profile resolves to nothing at call time, so the
 * warning lives HERE — where the choice is made — rather than surfacing as a
 * `no-profile` error inside whatever feature happened to ask first.
 */
export function AiDefaultsCard() {
  const { t } = useTranslation()
  const system = useSystem()
  const profiles = useInstancesOfCap({ functionCap: 'llm' }).data ?? []
  const defaultsQuery = useQuery({
    queryKey: DEFAULTS_KEY,
    queryFn: (): Promise<readonly LlmDefault[]> => system.trpcClient.llm.getDefaults.query({}),
  })
  const setDefault = useMutation({
    mutationFn: (input: { purpose: 'text' | 'vision'; profileId: string | null }) =>
      system.trpcClient.llm.setDefault.mutate({
        selector: { purpose: input.purpose },
        profileId: input.profileId,
      }),
    onSuccess: () => {
      void defaultsQuery.refetch()
    },
  })

  const currentFor = (purpose: 'text' | 'vision'): string => {
    const match = (defaultsQuery.data ?? []).find(
      (d) => 'purpose' in d.selector && d.selector.purpose === purpose,
    )
    return match?.profileId ?? ''
  }

  const labelFor = (purpose: 'text' | 'vision'): string =>
    purpose === 'vision'
      ? t('ai.defaultVision', 'Default vision profile')
      : t('ai.defaultText', 'Default text profile')

  return (
    <SectionCard headingId="ai-profiles-defaults" title={t('ai.defaultsTitle', 'Defaults')}>
      <div className={`${SECTION_BODY} grid gap-4 sm:grid-cols-2`}>
        {DEFAULT_PURPOSES.map(({ purpose, visionOnly }) => {
          const eligible = visionOnly ? profiles.filter(profileSupportsVision) : profiles
          const current = currentFor(purpose)
          const chosen = profiles.find((p) => p.id === current)
          return (
            <div key={purpose}>
              <Label className="mb-1 block" htmlFor={`llm-default-${purpose}`}>
                {labelFor(purpose)}
              </Label>
              <Select
                id={`llm-default-${purpose}`}
                aria-label={labelFor(purpose)}
                value={current}
                onChange={(e) =>
                  setDefault.mutate({
                    purpose,
                    // An empty option value is the DOM's only "nothing"; the cap
                    // spells it `null`, and '' would be stored as a profile id
                    // that resolves to no profile forever.
                    profileId: e.target.value === '' ? null : e.target.value,
                  })
                }
                options={[
                  { value: '', label: t('ai.none', 'None') },
                  // The stored id ALWAYS has an option, even when the profile
                  // list has not arrived or no longer contains it. Without one
                  // a `<select>` silently falls back to "None" and the next
                  // keystroke writes that fallback back — the picker would
                  // erase the very default it was opened to show.
                  ...(current !== '' && !eligible.some((p) => p.id === current)
                    ? [{ value: current, label: chosen?.name ?? current }]
                    : []),
                  ...eligible.map((p) => ({
                    value: p.id,
                    label: profileModel(p) === '' ? p.name : `${p.name} · ${profileModel(p)}`,
                  })),
                ]}
              />
              {current !== '' && chosen === undefined && (
                <p className="mt-1 text-xs text-danger">
                  {t('ai.defaultMissing', 'This default names a profile that no longer exists.')}
                </p>
              )}
              {chosen !== undefined && !chosen.enabled && (
                <p className="mt-1 text-xs text-warning">
                  {t(
                    'ai.defaultDisabled',
                    'This default profile is disabled — callers resolve to no profile.',
                  )}
                </p>
              )}
              {setDefault.error != null && (
                <p className="mt-1 text-xs text-danger">{String(setDefault.error)}</p>
              )}
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}
