/**
 * AddressSelector — pick one or many addresses from a `LocalInterface[]`.
 *
 * Reusable composite for "operator picks the addresses that should
 * participate in the connection-endpoint candidate list" workflows.
 * The selector is content-agnostic: pass in any list of interfaces
 * and a current selection, get back the new selection on every toggle.
 *
 * Modes:
 *   - `mode='single'`: returns the picked address (string) or `null`.
 *   - `mode='multiple'`: returns the full selected set as `string[]`.
 *
 * Visual: grouped by kind (LAN/Wi-Fi/Docker/VPN/Loopback/Other), each
 * row shows name + family badge + address + CIDR + auto-preferred
 * flag. Loopback is rendered but always disabled — it's the SDK's
 * mandatory last-resort fallback and the cap forces it through.
 */
import { useMemo } from 'react'
import { Network, Wifi, Boxes, Lock, Server, Check, AlertTriangle } from 'lucide-react'
import type { LocalInterface } from '@camstack/types'
import { useTranslation } from 'react-i18next'

const KIND_ICON: Record<string, typeof Network> = {
  lan: Network,
  wifi: Wifi,
  docker: Boxes,
  vpn: Lock,
  loopback: Server,
  other: Server,
}

const KIND_LABEL: Record<string, string> = {
  lan: 'LAN',
  wifi: 'Wi-Fi',
  docker: 'Docker',
  vpn: 'VPN',
  loopback: 'Loopback',
  other: 'Other',
}

const KIND_ORDER: Array<LocalInterface['kind']> = [
  'lan',
  'wifi',
  'vpn',
  'docker',
  'other',
  'loopback',
]

export type AddressSelectorMode = 'single' | 'multiple'

interface SingleProps {
  readonly mode: 'single'
  readonly value: string | null
  readonly onChange: (next: string | null) => void
}

interface MultipleProps {
  readonly mode: 'multiple'
  readonly value: readonly string[]
  readonly onChange: (next: readonly string[]) => void
}

export type AddressSelectorProps = (SingleProps | MultipleProps) & {
  readonly interfaces: readonly LocalInterface[]
  /** Optional disabled flag — disables every row + the action callbacks. */
  readonly disabled?: boolean
  /** Drop loopback entries entirely from the rendered list. Default `false`
   *  (loopback shows as disabled-with-hint so the operator sees it always
   *  participates regardless of selection). */
  readonly hideLoopback?: boolean
  /** Drop IPv6 entries. Default `false`. */
  readonly ipv4Only?: boolean
  /** Empty-state message when there are zero candidates. */
  readonly emptyMessage?: string
}

export function AddressSelector(props: AddressSelectorProps) {
  const { t } = useTranslation()
  const { interfaces, disabled, hideLoopback, ipv4Only, emptyMessage } = props

  const filtered = useMemo(() => {
    return interfaces.filter((i) => {
      if (hideLoopback && i.kind === 'loopback') return false
      if (ipv4Only && i.family !== 'IPv4') return false
      return true
    })
  }, [interfaces, hideLoopback, ipv4Only])

  const grouped = useMemo(() => {
    const buckets = new Map<LocalInterface['kind'], LocalInterface[]>()
    for (const iface of filtered) {
      const list = buckets.get(iface.kind) ?? []
      list.push(iface)
      buckets.set(iface.kind, list)
    }
    return KIND_ORDER.filter((k) => buckets.has(k)).map((k) => ({
      kind: k,
      items: buckets.get(k)!,
    }))
  }, [filtered])

  const isSelected = (address: string): boolean => {
    if (props.mode === 'single') return props.value === address
    return props.value.includes(address)
  }

  const toggle = (iface: LocalInterface): void => {
    if (disabled || iface.kind === 'loopback') return
    if (props.mode === 'single') {
      props.onChange(props.value === iface.address ? null : iface.address)
      return
    }
    const set = new Set(props.value)
    if (set.has(iface.address)) set.delete(iface.address)
    else set.add(iface.address)
    props.onChange([...set])
  }

  if (filtered.length === 0) {
    return (
      <div className="text-xs text-foreground-subtle italic">
        {emptyMessage ??
          t('shared.addressSelector.noAddressesAvailable', 'No addresses available.')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {grouped.map(({ kind, items }) => {
        const Icon = KIND_ICON[kind] ?? Server
        return (
          <div key={kind} className="rounded-md border border-border overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-hover/30 border-b border-border">
              <Icon className="h-3.5 w-3.5 text-foreground-subtle" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                {KIND_LABEL[kind] ?? kind}
              </span>
              <span className="text-[10px] text-foreground-subtle">· {items.length}</span>
            </div>
            <ul className="divide-y divide-border">
              {items.map((iface) => {
                const checked = isSelected(iface.address)
                const isLoopback = iface.kind === 'loopback'
                // `plausible` = backend's heuristic flag. Non-plausible
                // entries (link-local, multicast, docker, vpn, …) get a
                // muted row + amber warning badge so the operator sees
                // them but understands why they're risky to pin.
                const isNonPlausible = !iface.plausible && !isLoopback
                return (
                  <li
                    key={`${iface.name}-${iface.family}-${iface.address}`}
                    className={`flex items-center gap-3 px-3 py-2 ${
                      isLoopback
                        ? 'opacity-60 cursor-not-allowed'
                        : disabled
                          ? 'opacity-60'
                          : isNonPlausible
                            ? 'cursor-pointer hover:bg-surface-hover/30 bg-amber-500/[0.04]'
                            : 'cursor-pointer hover:bg-surface-hover/30'
                    }`}
                    onClick={() => toggle(iface)}
                  >
                    <span
                      className={`flex items-center justify-center h-4 w-4 rounded ${
                        props.mode === 'single' ? 'rounded-full' : 'rounded'
                      } border ${
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-surface'
                      }`}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <div
                      className={`flex-1 min-w-0 ${isNonPlausible ? 'text-foreground-subtle' : ''}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`font-mono text-xs font-semibold ${
                            isNonPlausible ? 'text-foreground-subtle' : 'text-foreground'
                          }`}
                        >
                          {iface.name}
                        </span>
                        <span className="text-[10px] rounded px-1.5 py-0.5 bg-foreground-subtle/10 text-foreground-subtle font-mono">
                          {iface.family}
                        </span>
                        {iface.preferred && (
                          <span className="text-[10px] rounded-full px-2 py-0.5 font-medium bg-primary/15 text-primary">
                            {t('shared.addressSelector.autoPreferred', 'Auto-preferred')}
                          </span>
                        )}
                        {isLoopback && (
                          <span className="text-[10px] rounded-full px-2 py-0.5 font-medium bg-foreground-subtle/15 text-foreground-subtle">
                            {t('shared.addressSelector.alwaysIncluded', 'Always included')}
                          </span>
                        )}
                        {isNonPlausible && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] rounded-full px-2 py-0.5 font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            title={iface.plausibleReason || undefined}
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {t('shared.addressSelector.unlikelyUsable', 'Unlikely usable')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-foreground-subtle mt-0.5 font-mono break-all">
                        {iface.address}
                        {iface.cidr && iface.cidr !== iface.address ? ` (${iface.cidr})` : ''}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
