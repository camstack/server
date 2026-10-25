declare module 'onvif' {
  /** Minimal surface of the untyped `onvif` library — only the WS-Discovery API this addon uses. */
  export const Discovery: {
    on(event: string, listener: (...args: unknown[]) => void): void
    probe(options: Record<string, unknown>): void
    removeAllListeners(event: string): void
  }
}
