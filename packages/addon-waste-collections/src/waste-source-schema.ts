/**
 * Shared create defaults when a service has not been chosen yet.
 * The live dialog schema comes from `serviceFormSchema(serviceId)`.
 */
export const WASTE_SOURCE_CREATE_VALUES: Record<string, unknown> = {
  label: 'New source',
  enabled: true,
}
