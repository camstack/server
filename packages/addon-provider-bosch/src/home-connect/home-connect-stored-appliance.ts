import type { HomeConnectGatewayConfig, HomeConnectStoredAppliance } from './config.js'
import type { HomeConnectListedAppliance } from './home-connect-login.js'

function stubDeviceDescriptionObject(row: HomeConnectStoredAppliance): Record<string, unknown> {
  return {
    info: { deviceID: row.haId, deviceType: row.type, model: row.name },
  }
}

function stubDeviceDescription(row: HomeConnectStoredAppliance): string {
  return JSON.stringify(stubDeviceDescriptionObject(row))
}

function serializedDeviceDescription(row: HomeConnectStoredAppliance): string {
  if (row.deviceDescription === undefined) return stubDeviceDescription(row)
  if (typeof row.deviceDescription === 'string') return row.deviceDescription
  return JSON.stringify(row.deviceDescription)
}

export function gatewayConfigFromStored(row: HomeConnectStoredAppliance): HomeConnectGatewayConfig {
  return {
    host: row.host,
    psk: row.psk,
    mode: row.mode,
    iv64: row.iv64,
    deviceDescription: row.deviceDescription ?? stubDeviceDescriptionObject(row),
  }
}

function isDescriptionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseLoginDeviceDescription(raw: string): {
  readonly deviceDescription?: Record<string, unknown>
} {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isDescriptionRecord(parsed)) return { deviceDescription: parsed }
  } catch {
    return {}
  }
  return {}
}

export function listedApplianceFromStored(
  row: HomeConnectStoredAppliance,
): HomeConnectListedAppliance {
  return {
    haId: row.haId,
    name: row.name,
    type: row.type,
    connection: {
      host: row.host,
      psk: row.psk,
      mode: row.mode,
      iv64: row.iv64 ?? '',
      deviceDescription: serializedDeviceDescription(row),
    },
  }
}
