export const packageRoot: string;
export const publicKey: string;
export const platforms: Record<string, { runner: string; target: string; baseline: string }>;
export const releaseTag: string;
export function platformKey(platform?: string, architecture?: string): string;
export function artifactName(key: string): string;
export function sourceDigest(root?: string): Promise<string>;
