/** Kebab-case / PascalCase helpers used by scaffold + cap stubs. */

const INVALID = /[^a-zA-Z0-9-_]+/g

export function toFileName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(INVALID, '-')
    .replace(/^-+|-+$/g, '')
  const parts = cleaned
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
    .split('-')
    .filter((p) => p.length > 0)
  if (parts.length === 0) {
    throw new Error(`Invalid name: ${raw}`)
  }
  return parts.join('-')
}

export function toClassName(raw: string): string {
  return toFileName(raw)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export function toCamelName(raw: string): string {
  const cls = toClassName(raw)
  return cls.charAt(0).toLowerCase() + cls.slice(1)
}

export function toCapExportName(raw: string): string {
  return `${toCamelName(raw)}Capability`
}
