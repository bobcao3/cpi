import { createProject } from "../core/db";
import {
  archiveColumn,
  createColumn,
  listColumns,
  moveColumn,
  renameColumn,
} from "../core/columns";
import {
  archiveTask,
  createTask,
  getTask,
  moveTask,
  setTaskCompleted,
  unarchiveTask,
  updateTask,
} from "../core/tasks";
import {
  archiveTopic,
  attachTopic,
  createTopic,
  detachTopic,
  renameTopic,
} from "../core/topics";
import { createMessage } from "../core/messages";
import { authorString, resolveIdentity } from "../core/identity";
import { renderColumns, renderTopics } from "./admin";
import { renderBoard } from "./board";
import { renderCard } from "./card";
import {
  enc,
  field,
  htmxForm,
  parseDate,
  parseInteger,
  readForm,
  safeId,
  type Notice,
} from "./html";
import { pageResponse } from "./layout";

function mutationPage(
  request: Request,
  content: string,
  title: string,
  pathname: string,
  closeDialog = false,
): Response {
  if (request.headers.get("HX-Request") !== "true")
    return Response.redirect(new URL(pathname, request.url).toString(), 303);
  const headers: Record<string, string> = { "HX-Push-Url": pathname };
  if (closeDialog) headers["HX-Trigger"] = "tuidos:close-dialog";
  return pageResponse(request, content, title, { headers });
}

export function restoreNotice(
  projectId: string,
  taskId: string,
): Notice | undefined {
  const task = getTask(projectId, taskId);
  if (!task || task.archived_at == null) return undefined;
  const url = `/projects/${enc(projectId)}/tasks/${enc(taskId)}/restore`;
  return {
    kind: "ok",
    message: `Archived ${task.title}.`,
    action: `<form class="notice-action" action="${url}" method="post" hx-post="${url}" ${htmxForm}><button type="submit">Restore</button></form>`,
  };
}

async function postProject(request: Request): Promise<Response> {
  const form = await readForm(request);
  const name = field(form, "name", 128);
  const description = field(form, "description", 512, false) || null;
  const project = createProject(name, description);
  return mutationPage(
    request,
    renderBoard(project.id, "", { kind: "ok", message: `Created ${name}.` }),
    name,
    `/projects/${project.id}`,
    true,
  );
}

async function postTask(
  request: Request,
  projectId: string,
): Promise<Response> {
  const form = await readForm(request);
  const columnId = safeId(field(form, "column", 32), "column");
  if (!listColumns(projectId).some((column) => column.id === columnId))
    throw new Error(
      "column is unavailable — choose an active column and try again",
    );
  const title = field(form, "title", 256);
  const description = field(form, "description", 1024, false) || null;
  createTask(projectId, { title, description, column_id: columnId });
  return mutationPage(
    request,
    renderBoard(projectId, "", { kind: "ok", message: `Created ${title}.` }),
    "Board",
    `/projects/${projectId}`,
    true,
  );
}

async function postTaskAction(
  request: Request,
  projectId: string,
  taskId: string,
  action: string,
  extra?: string,
): Promise<Response> {
  const task = getTask(projectId, taskId);
  if (!task) throw new Error("card is unavailable — return to the board");
  if (action === "restore") {
    const restored = unarchiveTask(projectId, taskId);
    return mutationPage(
      request,
      renderBoard(projectId, "", {
        kind: "ok",
        message: `Restored ${restored.title}.`,
      }),
      "Board",
      `/projects/${projectId}`,
    );
  }
  if (task.archived_at != null)
    throw new Error(
      "card is archived — restore it from the board before changing it",
    );
  const form = await readForm(request);
  const base = `/projects/${projectId}/tasks/${taskId}`;
  if (action === "edit") {
    const column = safeId(field(form, "column", 32), "column");
    if (!listColumns(projectId).some((item) => item.id === column))
      throw new Error("column is unavailable — choose another and try again");
    const estimateRaw = field(form, "estimate", 12, false);
    updateTask(projectId, taskId, {
      title: field(form, "title", 256),
      description: field(form, "description", 1024, false) || null,
      priority: parseInteger(field(form, "priority", 1), "priority", 0, 4),
      assignee: field(form, "assignee", 256, false) || null,
      estimate: estimateRaw
        ? parseInteger(estimateRaw, "estimate", 0, 1_000_000)
        : null,
      due_at: parseDate(field(form, "due", 10, false)),
    });
    if (column !== task.column_id) moveTask(projectId, taskId, column);
    return mutationPage(
      request,
      renderCard(projectId, taskId, { kind: "ok", message: "Card updated." }),
      task.title,
      base,
    );
  }
  if (action === "move") {
    const column = safeId(field(form, "column", 32), "column");
    if (!listColumns(projectId).some((item) => item.id === column))
      throw new Error(
        "destination is unavailable — refresh the board and try again",
      );
    moveTask(projectId, taskId, column);
    return mutationPage(
      request,
      renderBoard(projectId, "", {
        kind: "ok",
        message: `Moved ${task.title}.`,
      }),
      "Board",
      `/projects/${projectId}`,
    );
  }
  if (action === "completion") {
    const surface = field(form, "surface", 16, false);
    const completed = field(form, "completed", 1) === "1";
    setTaskCompleted(projectId, taskId, completed);
    const notice: Notice = {
      kind: "ok",
      message: completed ? "Card completed." : "Card reopened.",
    };
    return surface === "board"
      ? mutationPage(
          request,
          renderBoard(projectId, "", notice),
          "Board",
          `/projects/${projectId}`,
        )
      : mutationPage(
          request,
          renderCard(projectId, taskId, notice),
          task.title,
          base,
        );
  }
  if (action === "archive") {
    archiveTask(projectId, taskId);
    const location = `/projects/${projectId}?restore=${taskId}`;
    return mutationPage(
      request,
      renderBoard(projectId, "", restoreNotice(projectId, taskId), taskId),
      "Board",
      location,
    );
  }
  if (action === "messages") {
    const content = field(form, "content", 16_384);
    createMessage(projectId, taskId, authorString(resolveIdentity()), content);
    return mutationPage(
      request,
      renderCard(projectId, taskId, { kind: "ok", message: "Message posted." }),
      task.title,
      base,
    );
  }
  if (action === "topics" && extra) {
    const topicId = safeId(extra, "topic");
    const attached = field(form, "attached", 1) === "1";
    if (attached) attachTopic(projectId, taskId, topicId);
    else detachTopic(projectId, taskId, topicId);
    return mutationPage(
      request,
      renderCard(projectId, taskId, {
        kind: "ok",
        message: attached ? "Topic attached." : "Topic removed.",
      }),
      task.title,
      base,
    );
  }
  throw new Error("action is unavailable — reload the page and try again");
}

async function postAdmin(
  request: Request,
  projectId: string,
  area: string,
  recordId?: string,
  action?: string,
): Promise<Response> {
  const form = await readForm(request);
  if (area === "topics") {
    if (!recordId) createTopic(projectId, field(form, "name", 128));
    else if (action === "rename")
      renameTopic(
        projectId,
        safeId(recordId, "topic"),
        field(form, "name", 128),
      );
    else if (action === "archive")
      archiveTopic(projectId, safeId(recordId, "topic"));
    else
      throw new Error("action is unavailable — reload the page and try again");
    return mutationPage(
      request,
      renderTopics(projectId, {
        kind: "ok",
        message: "Topic catalog updated.",
      }),
      "Topics",
      `/projects/${projectId}/topics`,
    );
  }
  if (area === "columns") {
    if (!recordId) createColumn(projectId, field(form, "name", 64));
    else if (action === "rename")
      renameColumn(
        projectId,
        safeId(recordId, "column"),
        field(form, "name", 64),
      );
    else if (action === "move")
      moveColumn(
        projectId,
        safeId(recordId, "column"),
        parseInteger(field(form, "position", 3), "position", 0, 63),
      );
    else if (action === "archive")
      archiveColumn(projectId, safeId(recordId, "column"));
    else
      throw new Error("action is unavailable — reload the page and try again");
    return mutationPage(
      request,
      renderColumns(projectId, {
        kind: "ok",
        message: "Board structure updated.",
      }),
      "Columns",
      `/projects/${projectId}/columns`,
    );
  }
  throw new Error("action is unavailable — reload the page and try again");
}

export async function postRoute(
  request: Request,
  part: string[],
): Promise<Response> {
  if (part.length === 1 && part[0] === "projects") return postProject(request);
  if (part[0] !== "projects")
    throw new Error("action is unavailable — reload the page and try again");
  const projectId = safeId(part[1], "project");
  if (part.length === 3 && part[2] === "tasks")
    return postTask(request, projectId);
  if ((part[2] === "topics" || part[2] === "columns") && part.length === 3)
    return postAdmin(request, projectId, part[2]);
  if ((part[2] === "topics" || part[2] === "columns") && part.length === 5)
    return postAdmin(request, projectId, part[2], part[3], part[4]);
  if (part[2] !== "tasks")
    throw new Error("action is unavailable — reload the page and try again");
  const taskId = safeId(part[3], "card");
  if (part.length === 5)
    return postTaskAction(request, projectId, taskId, part[4]!);
  if (part.length === 6 && part[4] === "topics")
    return postTaskAction(request, projectId, taskId, "topics", part[5]);
  throw new Error("action is unavailable — reload the page and try again");
}
