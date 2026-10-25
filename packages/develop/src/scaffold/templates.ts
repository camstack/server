export function renderTemplate(source: string, vars: Readonly<Record<string, string>>): string {
  return source.replace(/<%= (\w+) %>/g, (_match, key: string) => {
    const value = vars[key]
    if (value === undefined) {
      throw new Error(`Template variable missing: ${key}`)
    }
    return value
  })
}
