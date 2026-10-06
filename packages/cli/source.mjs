import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = new URL("../../package.json", import.meta.url);
if (existsSync(repository)) {
  const root = JSON.parse(readFileSync(repository, "utf8"));
  if (root.bin?.cpi === "packages/cli/bin/cpi") {
    if (!Array.isArray(root.workspaces) || root.workspaces.length > 16)
      throw new Error("Invalid source workspace list");
    const aliases = JSON.parse(process.env.JITI_ALIAS || "{}");
    for (const folder of root.workspaces) {
      if (!/^packages\/[a-z-]+$/.test(folder))
        throw new Error("Invalid source workspace path");
      const base = new URL(`${folder}/`, repository);
      const manifest = JSON.parse(
        readFileSync(new URL("package.json", base), "utf8"),
      );
      if (!manifest.name.startsWith("@cpi/"))
        throw new Error("Invalid source workspace name");
      for (const [name, value] of Object.entries(manifest.exports)) {
        const target =
          typeof value === "string" ? value : (value.import ?? value.default);
        if (!target?.startsWith("./")) continue;
        aliases[`${manifest.name}${name === "." ? "" : name.slice(1)}`] =
          fileURLToPath(new URL(target, base));
      }
    }
    process.env.JITI_ALIAS = JSON.stringify(aliases);
  }
}
