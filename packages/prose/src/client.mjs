import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));

function detect_device(requested) {
  if (requested !== "auto")
    return { device: requested, hardware: `explicit ${requested}` };
  if (process.platform === "darwin" && process.arch === "arm64")
    return { device: "mps", hardware: "Apple Silicon / Metal" };
  const visible = process.env.CUDA_VISIBLE_DEVICES;
  if (visible !== "" && visible !== "-1") {
    const probe = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 16384,
      },
    );
    if (probe.status === 0 && probe.stdout.trim())
      return {
        device: "cuda",
        hardware: probe.stdout.trim().split("\n").join(", "),
      };
    if (existsSync("/dev/nvidiactl"))
      return { device: "cuda", hardware: "NVIDIA CUDA driver" };
  }
  return { device: "cpu", hardware: "no supported accelerator detected" };
}

export async function request(
  method,
  params = {},
  options = {},
  logger = new Logger(),
) {
  const environment = { ...process.env };
  if (options.device) environment.CPI_PROSE_DEVICE = options.device;
  if (options["no-tone"]) environment.CPI_PROSE_TONE_MODEL = "";
  if (options["no-compile"]) environment.CPI_PROSE_COMPILE = "0";
  if (options.style) {
    environment.CPI_PROSE_STYLE_MODEL ||= "styledistance";
  }
  if (options["no-style"]) environment.CPI_PROSE_STYLE_MODEL = "";
  environment.PYTHONUNBUFFERED = "1";
  environment.OMP_NUM_THREADS ||= String(Math.min(8, availableParallelism()));
  environment.MKL_NUM_THREADS ||= environment.OMP_NUM_THREADS;
  const requested = environment.CPI_PROSE_DEVICE ?? "auto";
  if (!["auto", "cpu", "cuda", "mps"].includes(requested))
    throw new Error("Device must be auto, cpu, cuda, or mps");
  const { device, hardware } = detect_device(requested);
  environment.CPI_PROSE_DEVICE = device;
  if (device === "cpu") environment.TORCHINDUCTOR_FREEZING ??= "1";
  const backend =
    device === "cuda"
      ? "cuda"
      : process.platform === "darwin"
        ? "apple"
        : "cpu";
  const identity = createHash("sha256")
    .update(project)
    .digest("hex")
    .slice(0, 20);
  const cache = join(
    environment.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "cpi-prose",
  );
  const python_environment = join(
    cache,
    "environments",
    `${identity}-${backend}`,
  );
  if (
    (method === "status" || method === "stop") &&
    !existsSync(join(python_environment, "bin/python"))
  )
    return method === "status"
      ? { running: false }
      : { running: false, stopped: false };
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  environment.UV_PROJECT_ENVIRONMENT = python_environment;
  environment.TORCHINDUCTOR_CACHE_DIR ||= join(cache, "torchinductor");
  environment.TORCHINDUCTOR_COMPILE_THREADS ||= String(
    Math.min(4, availableParallelism()),
  );
  logger.debug(`Hardware: ${hardware}; device=${device}.`);
  if (method === "analyze")
    logger.info(
      `Preparing Python 3.14 (${backend}) environment and analysis server...`,
    );
  const args = [
    "run",
    "--locked",
    "--no-dev",
    "--project",
    project,
    "--python",
    "3.14",
    "--extra",
    backend,
    "python",
    "-m",
    "cpi_prose.bridge",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("uv", args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    const logs = logger.stream();
    child.on("error", (error) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? "uv is required: https://docs.astral.sh/uv/getting-started/installation/"
            : error.message,
        ),
      );
    });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => {
      logs.write(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      logs.end();
      let result;
      try {
        result = JSON.parse(Buffer.concat(output).toString("utf8"));
      } catch {
        reject(
          new Error(
            `Python service exited ${signal ?? code} without a valid response. Use -vv for diagnostics.`,
          ),
        );
        return;
      }
      if (result.error) reject(new Error(result.error.message));
      else if (code !== 0)
        reject(new Error(`Python service exited ${signal ?? code}`));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify({ method, params }));
  });
}
