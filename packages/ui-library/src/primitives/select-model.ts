import { Children, Fragment, isValidElement, type ReactNode } from 'react'

/** One row of the dropdown list, flattened from `options` or `<option>` children. */
export interface SelectEntry {
  readonly value: string
  readonly label: string
  readonly disabled: boolean
  /** The `<optgroup label>` this row sits under, if any. */
  readonly group: string | null
}

export interface SelectOptionInput {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

/** Plain text of a node, the way a native `<option>` would render it. */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

interface OptionElementProps {
  readonly value?: string | number
  readonly disabled?: boolean
  readonly label?: string
  readonly children?: ReactNode
}

function collect(children: ReactNode, group: string | null, out: SelectEntry[]): void {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<OptionElementProps>(child)) continue
    if (child.type === Fragment) {
      collect(child.props.children, group, out)
    } else if (child.type === 'optgroup') {
      collect(child.props.children, child.props.label ?? '', out)
    } else if (child.type === 'option') {
      const label = nodeText(child.props.children)
      out.push({
        value: child.props.value === undefined ? label : String(child.props.value),
        label: child.props.label ?? label,
        disabled: child.props.disabled === true,
        group,
      })
    }
  }
}

/** The list the dropdown shows: `options` first, then parsed `<option>`/`<optgroup>` children. */
export function parseSelectEntries(
  options: readonly SelectOptionInput[] | undefined,
  children: ReactNode,
): SelectEntry[] {
  const out: SelectEntry[] = (options ?? []).map((o) => ({
    value: o.value,
    label: o.label,
    disabled: o.disabled === true,
    group: null,
  }))
  collect(children, null, out)
  return out
}

/** Index of the next enabled row from `from` in `step` direction, wrapping; -1 when none. */
export function nextEnabled(entries: readonly SelectEntry[], from: number, step: 1 | -1): number {
  const n = entries.length
  for (let i = 1; i <= n; i += 1) {
    const idx = (((from + step * i) % n) + n) % n
    if (!entries[idx]?.disabled) return idx
  }
  return -1
}

/** Type-ahead: the first enabled row after `from` whose label starts with `prefix` (wraps). */
export function findByPrefix(
  entries: readonly SelectEntry[],
  prefix: string,
  from: number,
): number {
  const needle = prefix.toLowerCase()
  const n = entries.length
  // A single repeated letter cycles through the matches, like a native list.
  const start = prefix.length > 1 && new Set(prefix.toLowerCase()).size === 1 ? from + 1 : from
  const probe = prefix.length > 1 && new Set(needle).size === 1 ? (needle[0] ?? needle) : needle
  for (let i = 0; i < n; i += 1) {
    const idx = (((start + i) % n) + n) % n
    const e = entries[idx]
    if (e !== undefined && !e.disabled && e.label.toLowerCase().startsWith(probe)) return idx
  }
  return -1
}
