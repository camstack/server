/**
 * Runtime access to the addon-local generated catalog (country → service).
 */
import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'
import catalogJson from './catalog.json'
import { isSecretArg } from './waste-secrets.js'

export interface CatalogField {
  readonly key: string
  readonly label: string
  readonly required: boolean
  readonly kind: 'text' | 'number' | 'boolean'
}

export interface CatalogService {
  readonly id: string
  readonly countryId: string
  readonly label: string
  readonly module: string
  readonly defaultArgs: Readonly<Record<string, string>>
  readonly fields: readonly CatalogField[]
}

export interface CatalogCountry {
  readonly id: string
  readonly label: string
}

export interface WasteCatalogFile {
  readonly generatedAt: string
  readonly sourceHash: string
  readonly countries: readonly CatalogCountry[]
  readonly services: readonly CatalogService[]
}

const WasteCatalogFileSchema: z.ZodType<WasteCatalogFile> = z.object({
  generatedAt: z.string(),
  sourceHash: z.string(),
  countries: z.array(z.object({ id: z.string(), label: z.string() })),
  services: z.array(
    z.object({
      id: z.string(),
      countryId: z.string(),
      label: z.string(),
      module: z.string(),
      defaultArgs: z.record(z.string(), z.string()),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          required: z.boolean(),
          kind: z.enum(['text', 'number', 'boolean']),
        }),
      ),
    }),
  ),
})

const catalog = WasteCatalogFileSchema.parse(catalogJson)

export function listCatalogCountries(): readonly CatalogCountry[] {
  return catalog.countries
}

export function listCatalogServices(countryId: string): readonly CatalogService[] {
  return catalog.services.filter((s) => s.countryId === countryId)
}

/**
 * Operator-facing service title. When the catalog pinned a service code
 * (`service` / `service_id`, e.g. AbfallNavi `zew2`), append it in parentheses.
 */
export function serviceDisplayLabel(service: CatalogService): string {
  const code = service.defaultArgs['service'] ?? service.defaultArgs['service_id']
  if (typeof code === 'string' && code.length > 0) {
    return `${service.label} (${code})`
  }
  return service.label
}

export function findCatalogService(serviceId: string): CatalogService | undefined {
  return catalog.services.find((s) => s.id === serviceId)
}

/** Match a stored module+args pair back to a catalog service (best effort). */
export function matchCatalogService(
  module: string,
  args: Readonly<Record<string, unknown>>,
): CatalogService | undefined {
  const candidates = catalog.services.filter((s) => s.module === module)
  if (candidates.length === 0) return undefined
  const scored = candidates.map((s) => {
    let score = 0
    for (const [k, v] of Object.entries(s.defaultArgs)) {
      if (args[k] === v) score += 2
      else if (args[k] !== undefined) score -= 1
    }
    return { s, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (best && best.score > 0) return best.s
  return candidates[0]
}

export function serviceFormSchema(service: CatalogService): ConfigUISchema {
  const argFields = service.fields.map((f) => {
    // A credential argument is a password field: keychain-backed, shown as "set" (D880).
    if (isSecretArg(f.key)) {
      return {
        type: 'password' as const,
        key: f.key,
        label: f.label,
        default: '',
      }
    }
    if (f.kind === 'boolean') {
      return {
        type: 'boolean' as const,
        key: f.key,
        label: f.label,
        default: false,
      }
    }
    if (f.kind === 'number') {
      return {
        type: 'number' as const,
        key: f.key,
        label: f.label,
        default: undefined,
      }
    }
    return {
      type: 'text' as const,
      key: f.key,
      label: f.label,
      default: '',
    }
  })

  return {
    sections: [
      {
        id: 'identity',
        title: 'Calendar',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'label',
            label: 'Label',
            description: 'Shown under System → Calendars.',
            default: service.label,
          },
          {
            type: 'boolean',
            key: 'enabled',
            label: 'Enabled',
            default: true,
          },
        ],
      },
      {
        id: 'args',
        title: serviceDisplayLabel(service),
        description: `Module \`${service.module}\`${
          Object.keys(service.defaultArgs).length > 0
            ? ` — fixed: ${Object.entries(service.defaultArgs)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')}`
            : ''
        }`,
        columns: 2,
        fields: argFields,
      },
    ],
  }
}

export function mergeServiceArgs(
  service: CatalogService,
  formValues: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...service.defaultArgs }
  for (const f of service.fields) {
    const v = formValues[f.key]
    if (v === undefined || v === null || v === '') continue
    out[f.key] = v
  }
  return out
}
