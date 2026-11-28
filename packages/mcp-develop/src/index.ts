/**
 * Library surface of `@dominevo/mcp-develop`. The `dominevo mcp` command
 * imports `registerDevelopTools` for its `develop` toolset, and the private
 * operator MCP imports it for the addon-author tools. There is no standalone
 * server: run `dominevo mcp --toolsets develop`.
 */
export { registerDevelopTools, type RegisterDevelopOptions } from './register.js'
