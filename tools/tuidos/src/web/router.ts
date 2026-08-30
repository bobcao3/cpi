import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getMediaForTask } from "../core/media";
import { mediaPath } from "../core/paths";
import { getTask } from "../core/tasks";
import { postRoute, restoreNotice } from "./actions";
import { renderActivity, renderTopics } from "./admin";
import {
  renderBoard,
  renderColumnEditor,
  renderColumnForm,
  renderTaskForm,
} from "./board";
import { renderCard, renderTaskEditor } from "./card";
import { renderHome } from "./home";
import { enc, escapeHtml, safeId } from "./html";
import { documentPage, pageResponse } from "./layout";
import { SECURITY_HEADERS } from "./security";

const STATIC_ROOT = path.resolve(import.meta.dir);
const HTMX_FILE = path.resolve(
  import.meta.dir,
  "../../node_modules/htmx.org/dist/htmx.min.js",
);
const MUTATION = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function secure(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    response.headers.set(name, value);
  return response;
}

function requireSameOrigin(request: Request): void {
  if (!MUTATION.has(request.method)) return;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site")
    throw new Error(
      "cross-origin write blocked — reload this page and try again",
    );
  const origin = request.headers.get("origin");
  if (!origin)
    throw new Error(
      "request origin is missing — reload this page and try again",
    );
  if (site === "same-origin") return;
  if (origin !== new URL(request.url).origin)
    throw new Error(
      "request origin did not match — reload this page and try again",
    );
}

function segments(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length > 8)
    throw new Error("address is too deep — return to Projects and try again");
  return parts;
}

function readAsset(file: string): {
  bytes: Buffer;
  etag: string;
  lastModified: string;
} {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const before = statSync(file, { bigint: true });
      if (!before.isFile() || before.size > 1_048_576n) throw new Error();
      const bytes = readFileSync(file);
      const after = statSync(file, { bigint: true });
      if (
        !after.isFile() ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs
      )
        continue;
      return {
        bytes,
        etag: `"${createHash("sha256").update(bytes).digest("base64url")}"`,
        lastModified: new Date(Number(after.mtimeNs) / 1_000_000).toUTCString(),
      };
    } catch {}
  }
  throw new Error("asset is unavailable or changed — retry the request");
}

function asset(
  file: string,
  type: string,
  request: Request,
  cacheControl = "public, max-age=0, must-revalidate",
): Response {
  const { bytes, etag, lastModified } = readAsset(file);
  const validators = {
    "cache-control": cacheControl,
    etag,
    "last-modified": lastModified,
  };
  const ifNoneMatch = request.headers.get("if-none-match");
  const matches =
    ifNoneMatch !== null
      ? ifNoneMatch.split(",").some((value) => {
          const tag = value.trim();
          return tag === "*" || tag.replace(/^W\//i, "") === etag;
        })
      : (() => {
          const since = request.headers.get("if-modified-since");
          return (
            since !== null && Date.parse(since) >= Date.parse(lastModified)
          );
        })();
  if ((request.method === "GET" || request.method === "HEAD") && matches)
    return new Response(null, { status: 304, headers: validators });
  return new Response(bytes, {
    headers: {
      ...validators,
      "content-type": type,
      "content-length": String(bytes.byteLength),
    },
  });
}

function errorResponse(request: Request, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const target =
    request.method === "POST" &&
    /^\/projects\/[^/]{32}\/tasks$/.test(new URL(request.url).pathname)
      ? "#modal-body"
      : "#notice";
  const panel = `<aside class="notice notice-error" role="alert"><strong>Action needed</strong><span>${escapeHtml(message)}</span><small>Correct the input and try again. If this persists, use clidos to inspect the record.</small></aside>`;
  if (request.headers.get("HX-Request") === "true")
    return new Response(panel, {
      status: 422,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "HX-Retarget": target,
        "HX-Reswap": "innerHTML",
      },
    });
  const home = renderHome("", { kind: "error", message });
  return new Response(documentPage(home, "Action needed"), {
    status: 422,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function notFound(request: Request): Response {
  return pageResponse(
    request,
    renderHome("", {
      kind: "error",
      message:
        "Page unavailable — return to Projects and choose an available record.",
    }),
    "Page unavailable",
    { status: 404 },
  );
}

async function getRoute(request: Request, url: URL, part: string[]) {
  if (part.length === 0)
    return pageResponse(
      request,
      renderHome(url.searchParams.get("q") ?? ""),
      "Projects",
    );
  if (
    part[0] === "assets" &&
    part.length === 2 &&
    ["styles.css", "board.css", "chrome.css"].includes(part[1]!)
  )
    return asset(
      path.join(STATIC_ROOT, part[1]!),
      "text/css; charset=utf-8",
      request,
    );
  if (part[0] === "assets" && part[1] === "site.js")
    return asset(
      path.join(STATIC_ROOT, "site.js"),
      "text/javascript; charset=utf-8",
      request,
    );
  if (part[0] === "assets" && part[1] === "htmx-4.0.0.min.js")
    return asset(
      HTMX_FILE,
      "text/javascript; charset=utf-8",
      request,
      "public, max-age=31536000, immutable",
    );
  if (part[0] !== "projects") return notFound(request);
  const projectId = safeId(part[1], "project");
  if (part.length === 2) {
    const archived = url.searchParams.get("restore");
    const archivedId = archived ? safeId(archived, "card") : undefined;
    const notice = archivedId
      ? restoreNotice(projectId, archivedId)
      : undefined;
    return pageResponse(
      request,
      renderBoard(
        projectId,
        url.searchParams.get("q") ?? "",
        notice,
        archivedId,
      ),
      "Board",
    );
  }
  if (part[2] === "task-form" && part.length === 3)
    return new Response(
      renderTaskForm(
        projectId,
        safeId(url.searchParams.get("column") ?? undefined, "column"),
      ),
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  if (part[2] === "columns" && part.length === 3)
    return Response.redirect(
      new URL(`/projects/${projectId}`, url).toString(),
      302,
    );
  if (part[2] === "column-form" && part.length === 3)
    return new Response(renderColumnForm(projectId), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  if (part[2] === "columns" && part.length === 5 && part[4] === "edit") {
    const columnId = safeId(part[3], "column");
    return new Response(renderColumnEditor(projectId, columnId), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (part[2] === "topics" && part.length === 3)
    return pageResponse(request, renderTopics(projectId), "Topics");
  if (part[2] === "activity" && part.length === 3)
    return pageResponse(request, renderActivity(projectId), "Activity");
  if (part[2] !== "tasks") return notFound(request);
  const taskId = safeId(part[3], "card");
  if (part.length === 4)
    return pageResponse(request, renderCard(projectId, taskId), "Card");
  if (part[4] === "edit" && part.length === 5)
    return pageResponse(
      request,
      renderTaskEditor(projectId, taskId),
      "Edit card",
    );
  if (part[4] === "media" && part.length === 6) {
    const task = getTask(projectId, taskId);
    if (!task || task.archived_at !== null)
      throw new Error(
        "card is archived or unavailable — restore it before downloading attachments",
      );
    const mediaId = safeId(part[5], "attachment");
    const media = getMediaForTask(projectId, taskId, mediaId);
    if (!media || !/^[0-9a-f]{64}$/.test(media.content_hash))
      throw new Error("attachment is unavailable — return to the card");
    if (!Number.isSafeInteger(media.size_bytes) || media.size_bytes < 0)
      throw new Error(
        "data error: attachment size is invalid — inspect the card with clidos and report it",
      );
    const blobPath = mediaPath(projectId, media.content_hash);
    if (!existsSync(blobPath))
      throw new Error(
        "data error: attachment blob is missing — inspect the card with clidos and report the missing blob",
      );
    const blob = Bun.file(blobPath);
    if (blob.size !== media.size_bytes)
      throw new Error(
        "data error: attachment size mismatch — inspect the card with clidos and report it",
      );
    const type = media.mime_type?.match(/^[\w.+-]+\/[\w.+-]+$/)
      ? media.mime_type
      : "application/octet-stream";
    return new Response(blob, {
      headers: {
        "content-type": type,
        "content-length": String(media.size_bytes),
        "content-disposition": `attachment; filename*=UTF-8''${enc(media.filename)}`,
      },
    });
  }
  return notFound(request);
}

export function createWebHandler() {
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request);
      const url = new URL(request.url);
      const part = segments(url);
      const response =
        request.method === "GET" || request.method === "HEAD"
          ? await getRoute(request, url, part)
          : request.method === "POST"
            ? await postRoute(request, part)
            : new Response("Method not allowed", { status: 405 });
      return secure(response);
    } catch (error) {
      return secure(errorResponse(request, error));
    }
  };
}
