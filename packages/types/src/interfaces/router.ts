export interface RouteRequest {
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string | string[]>>
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
}

export interface RouteResponse {
  status(code: number): RouteResponse
  json(data: unknown): void
  send(data: string | Buffer): void
  sendFile(path: string): void
  header(name: string, value: string): RouteResponse
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => void | Promise<void>
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export interface IAddonRouter {
  /** Public route — no auth required */
  public(method: HttpMethod, path: string, handler: RouteHandler): void
  /** Protected route — requires valid JWT or API key */
  protected(method: HttpMethod, path: string, handler: RouteHandler): void
  /** Admin route — requires admin role */
  admin(method: HttpMethod, path: string, handler: RouteHandler): void
  /** Serve static directory */
  static(urlPath: string, directory: string, options?: { auth?: boolean }): void
  /** Get the base URL prefix for this addon's routes */
  getBaseUrl(): string
}
