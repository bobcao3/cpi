import pc from "picocolors";
import { createWebHandler } from "./router";
import { startWebServer, type WebServer } from "./server";
import { detectTailnet, ensureCertificate } from "./tls";

interface LaunchOptions {
  port: number;
  cert?: string;
  key?: string;
  open: boolean;
  tailnet: boolean;
}

const usage = `# tuidos web launcher

Usage: tuidos [options]

  -p, --port <port>   HTTPS port (default: TUIDOS_PORT or 3443)
      --cert <file>   PEM certificate (requires --key)
      --key <file>    PEM private key (requires --cert)
      --open          Open the local URL in a browser
      --no-open       Do not open a browser
      --no-tailnet    Skip automatic private tailnet exposure
  -h, --help          Show this guide`;

function portNumber(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value))
    throw new Error(
      "port must be a number from 1024 to 65535 — choose a valid port",
    );
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error(
      "port must be between 1024 and 65535 — choose another port",
    );
  return port;
}

function desktopAvailable(): boolean {
  return (
    process.platform === "darwin" ||
    process.platform === "win32" ||
    Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  );
}

function requireRuntime(): void {
  const match = /^(\d+)\.(\d+)/.exec(Bun.version);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (major < 1 || (major === 1 && minor < 4))
    throw new Error(
      `Bun ${Bun.version} is unsupported; upgrade to Bun 1.4 or newer, then retry`,
    );
}

function parseOptions(argv: string[]): LaunchOptions | null {
  const environmentPort = process.env.TUIDOS_PORT;
  const options: LaunchOptions = {
    port: environmentPort ? portNumber(environmentPort) : 3443,
    open: desktopAvailable(),
    tailnet: true,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("-"))
        throw new Error(`${argument} requires a value — see tuidos --help`);
      return value;
    };
    if (argument === "-h" || argument === "--help") return null;
    if (argument === "-p" || argument === "--port")
      options.port = portNumber(next());
    else if (argument.startsWith("--port="))
      options.port = portNumber(argument.slice(7));
    else if (argument === "--cert") options.cert = next();
    else if (argument.startsWith("--cert=")) options.cert = argument.slice(7);
    else if (argument === "--key") options.key = next();
    else if (argument.startsWith("--key=")) options.key = argument.slice(6);
    else if (argument === "--open") options.open = true;
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--no-tailnet") options.tailnet = false;
    else throw new Error(`unknown option '${argument}' — see tuidos --help`);
  }
  return options;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  if (!Bun.which(command[0]!)) {
    console.error(`> Browser opener not found. Visit ${url}`);
    return;
  }
  Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

interface TailnetResult {
  url: string | null;
  reason?: string;
}

export async function launch(argv: string[]): Promise<void> {
  let server: WebServer | undefined;
  let directServer: WebServer | undefined;
  let tail: TailnetResult | undefined;
  let options: LaunchOptions | null;
  try {
    options = parseOptions(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${pc.red("*LAUNCH FAILED*")} ${message}`);
    process.exitCode = 2;
    return;
  }
  if (!options) {
    console.log(usage);
    return;
  }
  try {
    requireRuntime();
    const tailnet = options.tailnet ? detectTailnet() : null;
    const certificate = await ensureCertificate(
      options.cert,
      options.key,
      [tailnet?.dnsName, tailnet?.ipv4].filter((value): value is string =>
        Boolean(value),
      ),
    );
    const localUrl = `https://localhost:${options.port}`;
    server = await startWebServer({
      hostname: "127.0.0.1",
      port: options.port,
      cert: certificate.cert,
      key: certificate.key,
      fetch: createWebHandler(),
    });
    if (!options.tailnet) {
      tail = {
        url: null,
        reason: "Tailnet exposure disabled; the service remains loopback-only.",
      };
    } else if (!tailnet?.ipv4) {
      tail = {
        url: null,
        reason:
          "Tailscale was not ready or has no IPv4 address; the service remains loopback-only. Check Tailscale, then retry.",
      };
    } else {
      try {
        directServer = await startWebServer({
          hostname: tailnet.ipv4,
          port: options.port,
          cert: certificate.cert,
          key: certificate.key,
          fetch: createWebHandler(),
        });
        tail = {
          url: `https://${tailnet.dnsName}:${options.port}`,
        };
      } catch {
        tail = {
          url: null,
          reason:
            "Direct private HTTPS binding failed; the service remains loopback-only. Check the Tailscale address and permissions, then retry.",
        };
      }
    }
    console.log(`\n${pc.bold("# tuidos is online")}\n`);
    console.log(`${pc.cyan("*LOCAL*")}   ${localUrl}`);
    if (tail.url) console.log(`${pc.green("*TAILNET*")} ${tail.url}`);
    if (tail.reason) console.log(`> ${tail.reason}`);
    console.log(
      certificate.source === "self-signed"
        ? "> HTTPS uses a local self-signed certificate. Approve it on first visit."
        : "> HTTPS uses the certificate you provided.",
    );
    console.log("> HTTPS negotiates HTTP/2 on this port.");
    console.log("\nPress Ctrl-C to stop.\n");
    if (options.open) openBrowser(localUrl);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void directServer?.close();
      void server?.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await Promise.allSettled([directServer?.close(), server?.close()]);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${pc.red("*LAUNCH FAILED*")} ${message}`);
    console.error(
      "> Apply the remedy above, then retry. For an occupied port, choose another with --port.",
    );
    process.exitCode = 1;
  }
}
