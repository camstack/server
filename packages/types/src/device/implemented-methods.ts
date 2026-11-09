// Import-free on purpose: the runner reaches it through `@camstack/types/node`, never the schema barrel (D28).

/**
 * Which of a cap's methods a registered provider object serves. Sent with the
 * registration so the hub can tell "cap bound" from "cap bound AND this method
 * implemented". A method is implemented when the object has it as a function.
 */
export function implementedMethodsOf(methodNames: readonly string[], provider: object): string[] {
  return methodNames.filter((name) => typeof Reflect.get(provider, name) === 'function')
}
