type ToolPackages = {
  "@cpi/ghostmux/resolve": typeof import("@cpi/ghostmux/resolve");
  "@cpi/tree-sitter-wasm": typeof import("@cpi/tree-sitter-wasm");
  "@cpi/tree-sitter-wasm/resolve": typeof import("@cpi/tree-sitter-wasm/resolve");
};

export async function toolPackage<Name extends keyof ToolPackages>(
  name: Name,
): Promise<ToolPackages[Name]> {
  const source = JSON.parse(process.env.JITI_ALIAS || "{}")[name];
  if (!source) return import(name);
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
  }).import(source);
}
