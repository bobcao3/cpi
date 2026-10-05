import { randomInt } from "node:crypto";
import {
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";

const TIMEOUT_MS = 200;
interface ProbeState {
  supported: boolean;
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
const key = Symbol.for("cpi.kitty-probe");
const globals = globalThis as typeof globalThis & { [key: symbol]: ProbeState };
const state = (globals[key] ??= { supported: false });

export function kittyProbeSucceeded(): boolean {
  return state.supported;
}

export function stopKittyProbe(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.unsubscribe?.();
  state.unsubscribe = undefined;
}

export function startKittyProbe(ctx: ExtensionContext): void {
  stopKittyProbe();
  if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY)
    return;
  const settings = SettingsManager.create(ctx.cwd);
  const protocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
  if (
    !settings.getShowImages() ||
    settings.getTerminalCapabilityOverrides().images !== undefined ||
    (protocol !== undefined && protocol !== "auto") ||
    getCapabilities().images !== null
  ) {
    state.supported = false;
    return;
  }
  if (state.supported) return;

  const id = randomInt(1, 0xffffffff);
  const prefix = `\x1b_Gi=${id};`;
  state.unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!data.startsWith(prefix)) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
      state.supported = data === `${prefix}OK\x1b\\`;
    }
    return { consume: true };
  });
  state.timer = setTimeout(() => {
    state.timer = undefined;
  }, TIMEOUT_MS);
  process.stdout.write(`\x1b_Gi=${id},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`);
}
