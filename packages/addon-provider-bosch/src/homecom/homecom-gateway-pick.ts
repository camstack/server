import type { HomeComGatewayListing } from './homecom-api-client.js'
import { HOMECOM_BRANDS, HOMECOM_REGIONS, type HomeComConfig } from './config.js'

export interface HomeComGatewayChoice {
  readonly value: string
  readonly label: string
  readonly brand: HomeComConfig['brand']
  readonly region: HomeComConfig['region']
}

export type HomeComGatewayResolution =
  | {
      readonly kind: 'one'
      readonly gatewayId: string
      readonly brand: HomeComConfig['brand']
      readonly region: HomeComConfig['region']
    }
  | { readonly kind: 'many'; readonly options: readonly HomeComGatewayChoice[] }
  | { readonly kind: 'none' }

function brandOf(value: unknown): HomeComConfig['brand'] {
  for (const brand of HOMECOM_BRANDS) {
    if (value === brand) return brand
  }
  return 'bosch'
}

function regionOf(value: unknown): HomeComConfig['region'] {
  for (const region of HOMECOM_REGIONS) {
    if (value === region) return region
  }
  return 'eu'
}

function choiceOf(gateway: HomeComGatewayListing): HomeComGatewayChoice {
  return {
    value: gateway.gatewayId,
    label: gateway.name,
    brand: brandOf(gateway.brand),
    region: regionOf(gateway.region),
  }
}

/**
 * One gateway is filled in. Several stay a choice. None leaves the id empty
 * for Advanced.
 */
export function resolveHomeComGateway(
  gateways: readonly HomeComGatewayListing[],
): HomeComGatewayResolution {
  if (gateways.length === 0) return { kind: 'none' }
  const options = gateways.map(choiceOf)
  const only = options[0]
  if (gateways.length === 1 && only !== undefined) {
    return {
      kind: 'one',
      gatewayId: only.value,
      brand: only.brand,
      region: only.region,
    }
  }
  return { kind: 'many', options }
}
