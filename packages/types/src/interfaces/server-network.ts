/**
 * Server-side network resource-exposure interfaces.
 *
 * The former network-access provider/endpoint interfaces
 * (`INetworkAccessProvider`, `INetworkEndpoint`, `NetworkAccessStatus`,
 * `EndpointCapabilities`) were removed (2026-05-15) — they predated and
 * never matched the `network-access` capability contract, which is now
 * the single source of truth (`networkAccessCapability` in
 * `capabilities/network-access.cap.ts`).
 */

// --- Exposed Resources ---

export interface IExposedResource {
  id: string
  providerId: string
  deviceId?: string
  type: ExposedResourceType
  path: string
  auth: ResourceAuthMode
  description: string
  contentType?: string
  enabled: boolean
}

export type ExposedResourceType = 'snapshot' | 'stream' | 'webhook' | 'api' | 'media' | 'custom'

export type ResourceAuthMode =
  | { mode: 'public' }
  | { mode: 'token'; token: string }
  | { mode: 'api-key' }
  | { mode: 'jwt' }
  | { mode: 'ip-whitelist'; ips: string[] }

export interface IResourceExposer {
  getExposedResources(): IExposedResource[]
  handleResourceRequest(
    resourceId: string,
    request: ExposedResourceRequest,
  ): Promise<ExposedResourceResponse>
}

export interface ExposedResourceRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  headers: Record<string, string>
  query: Record<string, string>
  body?: Buffer | string
  remoteIp: string
}

export interface ExposedResourceResponse {
  status: number
  headers?: Record<string, string>
  body?: Buffer | string | NodeJS.ReadableStream
}
