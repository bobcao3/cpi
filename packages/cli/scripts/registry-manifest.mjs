import assert from "node:assert/strict";

export const registry_repository = "git+https://github.com/bobcao3/cpi.git";

export function registry_name(name) {
  if (name === "@cpi/cli") return "@bobcao3/cpi";
  if (name.startsWith("@cpi/")) return `@bobcao3/cpi-${name.slice(5)}`;
  if (name.startsWith("@earendil-works/")) {
    const suffix = name.slice("@earendil-works/".length);
    return `@bobcao3/${suffix === "chord" ? "pi-chord" : suffix}`;
  }
  return name;
}

export function registry_manifest(source, versions) {
  const manifest = structuredClone(source);
  manifest.name = registry_name(source.name);
  assert.notEqual(manifest.name, source.name);
  assert.equal(versions.get(source.name), manifest.version);
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.workspaces;
  delete manifest.overrides;
  delete manifest.publishConfig;
  manifest.publishConfig = {
    access: "public",
    registry: "https://registry.npmjs.org/",
  };
  manifest.repository = { type: "git", url: registry_repository };
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (registry_name(name) === name) continue;
      if (!versions.has(name)) {
        assert(
          !name.startsWith("@cpi/"),
          `Missing registry package for ${name}@${spec}`,
        );
        continue;
      }
      const version = versions.get(name);
      assert(version, `Missing registry package for ${name}@${spec}`);
      manifest[field][name] =
        field === "peerDependencies"
          ? version
          : `npm:${registry_name(name)}@${version}`;
    }
  }
  return manifest;
}
