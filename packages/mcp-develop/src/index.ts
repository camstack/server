/**
 * Library surface of `@camstack/mcp-develop`. The `camstack mcp` command
 * imports `registerDevelopTools` for its `develop` toolset; the
 * `camstack-mcp-develop` bin (`./server.js`) is a deprecated alias that runs
 * the same registration on its own stdio server.
 */
export { registerDevelopTools } from './register.js'
