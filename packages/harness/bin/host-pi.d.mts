import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type * as Ai from "@earendil-works/pi-ai";
import type * as Tui from "@earendil-works/pi-tui";

export function refreshHostRoutingEnv(env: NodeJS.ProcessEnv): void;
export function activePiRoot(): string;
export function piExecutableOnPath(): string;
export function hostCodingAgent(): Promise<typeof CodingAgent>;
export function hostAi(): Promise<typeof Ai>;
export function hostTui(): Promise<typeof Tui>;
