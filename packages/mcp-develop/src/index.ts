/**
 * Library surface of `@camstack/mcp-develop`. The `camstack mcp` command
 * imports `registerDevelopTools` for its `develop` toolset, and the private
 * operator MCP imports it for the addon-author tools. There is no standalone
 * server: run `camstack mcp --toolsets develop`.
 */
export { registerDevelopTools, type RegisterDevelopOptions } from './register.js'
