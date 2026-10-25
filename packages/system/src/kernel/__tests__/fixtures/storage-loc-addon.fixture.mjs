// Minimal addon module used by addon-loader.spec.ts to exercise
// `AddonLoader.loadFromPath` + `listStorageLocationDeclarations`.
// The class only needs an `initialize` on its prototype to be recognised
// by `resolveAddonClass` as an addon constructor.
export default class StorageLocFixtureAddon {
  async initialize() {}
  async shutdown() {}
}
