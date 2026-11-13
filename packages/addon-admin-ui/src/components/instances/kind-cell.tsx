import { Tooltip, TooltipContent, TooltipTrigger, useInstancesOfCap } from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import { type ReactElement, useCallback, useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAddonIconUrl } from '../../contexts/addon-icons-context'
import { hubPath } from '../../lib/mount'
import { linkedInstanceOf, type RowLink } from './instances-model'

/** What a Kind cell shows: the providing addon, the kind's label and, when it declares one, its icon. */
export interface KindCellProps {
  readonly addonId: string
  readonly label: string
  /** The addon's display name, beside the kind label in the icon's tooltip. */
  readonly providerName: string
  /** The kind's own icon (`IntegrationInstanceKind.iconUrl`); absent → the addon's icon. */
  readonly iconUrl?: string
  /** The instances the row's record links to; each shows as a small badge, named on hover. */
  readonly links?: readonly RowLink[]
}

/** The icon a Kind cell would draw: the kind's own, else the addon's. */
function resolvedKindIcon(
  iconUrl: string | undefined,
  addonIcon: string | null,
): string | undefined {
  if (iconUrl !== undefined && iconUrl !== '') return iconUrl
  return addonIcon ?? undefined
}

/** "<kind> · <provider>", plus "Sends via <name>" for each badge folded into the main icon. */
function kindIconTip(
  t: TFunction,
  label: string,
  providerName: string,
  links: readonly RowLink[] | undefined,
  folded: Readonly<Record<string, string>>,
): string {
  const base = t('instances.kindIconTip', '{{kind}} · {{provider}}', {
    kind: label,
    provider: providerName,
  })
  const linkKeys = new Set((links ?? []).map((link) => `${link.field}:${link.instanceId}`))
  const foldedNames = Object.entries(folded)
    .filter(([key]) => linkKeys.has(key))
    .map(([, name]) => name)
  if (foldedNames.length === 0) return base
  const via = foldedNames
    .map((name) => t('instances.sendsVia', 'Sends via {{name}}', { name }))
    .join(' · ')
  return `${base} · ${via}`
}

/**
 * The Kind cell of every instances table: the kind's declared icon, else the
 * provider's, then the kind label. An icon that is absent (or fails to load)
 * falls back to the next one, and with none the label stands alone — no
 * placeholder tile. A linked instance that resolves to the same icon is not
 * badged; the main icon names it.
 */
export function KindCell({
  addonId,
  label,
  providerName,
  iconUrl,
  links,
}: KindCellProps): ReactElement {
  const { t } = useTranslation()
  const ownIcon = resolvedKindIcon(iconUrl, useAddonIconUrl(addonId))
  const [folded, setFolded] = useState<Readonly<Record<string, string>>>({})
  const onFold = useCallback((key: string, name: string | null) => {
    setFolded((prev) => {
      if (name === null) {
        if (!(key in prev)) return prev
        const next: Record<string, string> = {}
        for (const [k, value] of Object.entries(prev)) {
          if (k !== key) next[k] = value
        }
        return next
      }
      if (prev[key] === name) return prev
      return { ...prev, [key]: name }
    })
  }, [])
  const tip = kindIconTip(t, label, providerName, links, folded)
  return (
    <span className="inline-flex items-center gap-1.5 text-foreground-muted">
      <Tooltip>
        <TooltipTrigger aria-label={tip} data-testid="kind-icon">
          <KindIcon addonId={addonId} {...(iconUrl !== undefined ? { iconUrl } : {})} />
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      {(links ?? []).map((link) => (
        <LinkedInstanceBadge
          key={`${link.field}:${link.instanceId}`}
          link={link}
          ownIcon={ownIcon}
          onFold={onFold}
        />
      ))}
      {label}
    </span>
  )
}

/**
 * The badge of one linked instance: its kind's icon (else its addon's). Hidden when that icon is
 * the row's own — the main icon names the instance instead. A link the target cap does not list
 * (yet, or any more) shows nothing: the row's own status says more.
 */
function LinkedInstanceBadge({
  link,
  ownIcon,
  onFold,
}: {
  readonly link: RowLink
  readonly ownIcon: string | undefined
  readonly onFold: (key: string, name: string | null) => void
}): ReactElement | null {
  const { t } = useTranslation()
  const query = useInstancesOfCap({
    functionCap: link.cap,
    ...(link.kind !== undefined ? { kind: link.kind } : {}),
  })
  const linked = linkedInstanceOf(query.data ?? [], link)
  const linkedIcon = resolvedKindIcon(linked?.iconUrl, useAddonIconUrl(linked?.addonId))
  const same = linked !== undefined && linkedIcon === ownIcon
  const key = `${link.field}:${link.instanceId}`
  const foldedName = same && linked !== undefined ? linked.name : null
  useLayoutEffect(() => {
    onFold(key, foldedName)
  }, [foldedName, key, onFold])
  if (linked === undefined || same) return null
  const via = t('instances.sendsVia', 'Sends via {{name}}', { name: linked.name })
  return (
    <Tooltip>
      <TooltipTrigger aria-label={via} data-testid="linked-instance-badge">
        <KindIcon
          addonId={linked.addonId}
          {...(linked.iconUrl !== undefined ? { iconUrl: linked.iconUrl } : {})}
          small
        />
      </TooltipTrigger>
      <TooltipContent>{via}</TooltipContent>
    </Tooltip>
  )
}

interface KindIconProps {
  readonly addonId: string
  readonly iconUrl?: string
  /** The badge size, for a linked instance beside the kind's own icon. */
  readonly small?: boolean
}

/** The first icon of (kind, addon) that loads; null when neither does. */
export function KindIcon({ addonId, iconUrl, small }: KindIconProps): ReactElement | null {
  const addonIcon = useAddonIconUrl(addonId)
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set())
  const src = [iconUrl, addonIcon].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate !== '' && !broken.has(candidate),
  )
  if (src === undefined) return null
  return (
    <img
      src={hubPath(src)}
      alt=""
      className={small === true ? 'h-3 w-3 shrink-0 rounded-sm' : 'h-4 w-4 shrink-0 rounded'}
      onError={() => setBroken((prev) => new Set([...prev, src]))}
    />
  )
}
