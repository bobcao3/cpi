import { afterAll, expect, test } from "bun:test";
import { connect as connectHttp2 } from "node:http2";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProjects } from "../core/db";
import { archiveColumn, createColumn, listColumns } from "../core/columns";
import { createTask, listTasks, moveTask } from "../core/tasks";
import { listTopics } from "../core/topics";
import { listMessages } from "../core/messages";
import { createWebHandler } from "./router";
import { startWebServer } from "./server";
import { ensureCertificate } from "./tls";

const state = mkdtempSync(path.join(tmpdir(), "tuidos-web-"));
process.env.TUIDOS_STATE_DIR = state;
const handler = createWebHandler();
const origin = "https://localhost:3443";

afterAll(() => rmSync(state, { recursive: true, force: true }));

const get = (pathname: string, fragment = false) =>
  handler(
    new Request(`${origin}${pathname}`, {
      headers: fragment ? { "HX-Request": "true" } : undefined,
    }),
  );

const post = (pathname: string, values: Record<string, string>) =>
  handler(
    new Request(`${origin}${pathname}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "HX-Request": "true",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(values),
    }),
  );

const h2Request = (
  port: number,
  pathname: string,
  method = "GET",
  body = "",
  extraHeaders: Record<string, string> = {},
) =>
  new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
  }>((resolve, reject) => {
    const client = connectHttp2(`https://localhost:${port}`, {
      rejectUnauthorized: false,
    });
    const request = client.request({
      ":path": pathname,
      ":method": method,
      ...(body
        ? {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": Buffer.byteLength(body).toString(),
          }
        : {}),
      ...extraHeaders,
    });
    let headers: Record<string, string | string[] | undefined> = {};
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.close();
      reject(error);
    };

    client.on("error", fail);
    request.on("error", fail);
    request.on("response", (responseHeaders) => {
      headers = responseHeaders;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.close();
          fail(new Error("HTTP/2 response exceeded 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (settled) return;
        settled = true;
        client.close();
        resolve({
          status: Number(headers[":status"]),
          headers,
          text: Buffer.concat(chunks).toString(),
        });
      });
    });
    request.end(body);
  });

test("browser workflow uses canonical HTML and shared core writes", async () => {
  const landing = await get("/");
  expect(landing.status).toBe(200);
  const landingHtml = await landing.text();
  expect(landingHtml).toContain("htmx-4.0.0.min.js");
  expect(landingHtml).toContain('src="/assets/site.js"');
  expect(landingHtml).not.toContain("?v=");
  expect(landingHtml).toContain("New project");

  const created = await post("/projects", {
    name: "Flight Deck",
    description: "Operational cards",
  });
  expect(created.status).toBe(200);
  expect(created.headers.get("HX-Trigger")).toBe("tuidos:close-dialog");
  const project = listProjects()[0]!;
  expect(project.name).toBe("Flight Deck");
  const column = listColumns(project.id)[0]!;

  const invalidTask = await post(`/projects/${project.id}/tasks`, {
    title: "",
    description: "Missing title",
    column: column.id,
  });
  expect(invalidTask.status).toBe(422);
  expect(invalidTask.headers.get("HX-Retarget")).toBe("#modal-body");

  const taskCreated = await post(`/projects/${project.id}/tasks`, {
    title: "Check <script> boundaries",
    description: "Serve canonical HTML",
    column: column.id,
  });
  expect(taskCreated.status).toBe(200);
  const boardHtml = await taskCreated.text();
  expect(boardHtml).toContain("Check &lt;script&gt; boundaries");
  expect(boardHtml).not.toContain("Check <script> boundaries");
  expect(boardHtml).toContain('<nav class="top-nav"');
  expect(boardHtml).toContain('<main class="workspace-body"');
  expect(boardHtml.indexOf('<nav class="top-nav"')).toBeLessThan(
    boardHtml.indexOf('<main class="workspace-body"'),
  );
  expect(boardHtml).toContain('<footer class="filterbar">');
  expect(boardHtml).toContain('id="board-filter"');
  expect(boardHtml.indexOf('<footer class="filterbar">')).toBeGreaterThan(
    boardHtml.indexOf('<main class="workspace-body"'),
  );
  expect(boardHtml).toContain('class="back-button"');
  expect(boardHtml).toContain('class="project-identity">Project: Flight Deck');
  expect(boardHtml).toContain('class="scroll-region"');
  expect(boardHtml).toContain('class="os8-scrollbar os8-vertical"');
  expect(boardHtml).toContain('class="os8-scrollbar os8-horizontal"');
  const task = listTasks(project.id)[0]!;

  const emptyColumn = createColumn(project.id, "Archived column");
  archiveColumn(project.id, emptyColumn.id);
  expect(() =>
    createTask(project.id, {
      title: "Blocked task",
      description: "",
      column_id: emptyColumn.id,
    }),
  ).toThrow("no active column");
  expect(() => moveTask(project.id, task.id, emptyColumn.id)).toThrow(
    "no active column",
  );

  const invalidDue = await post(
    `/projects/${project.id}/tasks/${task.id}/edit`,
    {
      title: "Check <script> boundaries",
      description: "Serve canonical HTML",
      column: column.id,
      priority: "0",
      assignee: "",
      estimate: "",
      due: "2024-02-30",
    },
  );
  expect(invalidDue.status).toBe(422);
  expect(await invalidDue.text()).toMatch(/calendar date/i);

  const message = await post(
    `/projects/${project.id}/tasks/${task.id}/messages`,
    { content: "Verified through the browser route." },
  );
  expect(message.status).toBe(200);
  expect(listMessages(project.id, task.id)).toHaveLength(1);

  const topic = listTopics(project.id)[0]!;
  const tagged = await post(
    `/projects/${project.id}/tasks/${task.id}/topics/${topic.id}`,
    { attached: "1" },
  );
  expect(tagged.status).toBe(200);
  expect(await tagged.text()).toContain('aria-pressed="true"');

  const completed = await post(
    `/projects/${project.id}/tasks/${task.id}/completion`,
    { completed: "1" },
  );
  expect(completed.status).toBe(200);
  expect(await completed.text()).toContain("Reopen card");
  const reopened = await post(
    `/projects/${project.id}/tasks/${task.id}/completion`,
    { completed: "0", surface: "board" },
  );
  expect(reopened.status).toBe(200);
  expect(reopened.headers.get("HX-Push-Url")).toBe(`/projects/${project.id}`);
  expect(await reopened.text()).toContain("Check &lt;script&gt; boundaries");

  const searched = await get(`/projects/${project.id}?q=boundaries`, true);
  expect(searched.status).toBe(200);
  expect(await searched.text()).toContain("Check &lt;script&gt; boundaries");

  const archived = await post(
    `/projects/${project.id}/tasks/${task.id}/archive`,
    {},
  );
  expect(archived.status).toBe(200);
  const archivedHtml = await archived.text();
  expect(archivedHtml).toContain("Restore");
  expect(archivedHtml).toMatch(/hx-get="[^"]*restore[^"]*"/i);
  const archivedCompletion = await post(
    `/projects/${project.id}/tasks/${task.id}/completion`,
    { completed: "1" },
  );
  expect(archivedCompletion.status).toBe(422);
  expect(await archivedCompletion.text()).toMatch(
    /archived.*restore|restore.*archived/i,
  );
  const restored = await post(
    `/projects/${project.id}/tasks/${task.id}/restore`,
    {},
  );
  expect(restored.status).toBe(200);
  expect(listTasks(project.id)).toHaveLength(1);

  const blocked = await handler(
    new Request(`${origin}/projects`, {
      method: "POST",
      headers: {
        Origin: "https://example.invalid",
        "HX-Request": "true",
      },
      body: new URLSearchParams({ name: "Blocked" }),
    }),
  );
  expect(blocked.status).toBe(422);
  expect(await blocked.text()).toContain("request origin did not match");

  const missingOrigin = await handler(
    new Request(`${origin}/projects`, {
      method: "POST",
      headers: {
        "HX-Request": "true",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name: "Missing origin" }),
    }),
  );
  expect(missingOrigin.status).toBe(422);
  expect(await missingOrigin.text()).toContain("request origin is missing");
  expect(listProjects()).toHaveLength(1);
});

test("TLS HTTP/2 adapter serves bounded requests", async () => {
  const certificate = await ensureCertificate(undefined, undefined, []);
  const server = await startWebServer({
    hostname: "127.0.0.1",
    port: 0,
    cert: certificate.cert,
    key: certificate.key,
    fetch: createWebHandler(),
  });

  try {
    const landing = await h2Request(server.port, "/");
    expect(landing.status).toBe(200);
    expect(landing.headers["content-security-policy"]).toContain(
      "object-src 'none'",
    );
    expect(landing.text).toContain("htmx-4.0.0.min.js");

    const asset = await h2Request(server.port, "/assets/site.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(asset.headers.etag).toMatch(/^".+"$/);
    expect(asset.headers["last-modified"]).toBeTruthy();
    expect(asset.text).toContain("commandForElement");
    expect(asset.text).toContain("bindScrollRegion");
    expect(asset.text).toContain("htmx:after:settle");

    const notModified = await h2Request(
      server.port,
      "/assets/site.js",
      "GET",
      "",
      { "if-none-match": asset.headers.etag as string },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.text).toBe("");
    expect(notModified.headers.etag).toBe(asset.headers.etag);

    const htmx = await h2Request(server.port, "/assets/htmx-4.0.0.min.js");
    expect(htmx.status).toBe(200);
    expect(htmx.headers["cache-control"]).toContain("immutable");

    const oversized = await h2Request(
      server.port,
      "/projects",
      "POST",
      "x".repeat(1_048_577),
    );
    expect(oversized.status).toBe(413);
    expect(oversized.headers["content-security-policy"]).toContain(
      "object-src 'none'",
    );
    expect(oversized.text).toMatch(/Request too large/i);
  } finally {
    await server.close();
  }
});
