declare module 'virtual:ui-shots-manifests' {
  const manifests: readonly ({
    id: string
    packageName: string
    packageVersion: string
  } & Record<string, unknown>)[]
  export default manifests
}
declare module 'virtual:ui-shots-addon-pages' {
  const pages: Record<string, () => Promise<{ default: unknown }>>
  export default pages
}
declare module 'virtual:ui-shots-addon-widgets' {
  const widgets: Record<string, () => Promise<{ default: unknown }>>
  export default widgets
}
