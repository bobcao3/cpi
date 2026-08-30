export interface Notice {
  kind: "ok" | "warn" | "error";
  message: string;
  action?: string;
}

export type RequestForm = Awaited<ReturnType<Request["formData"]>>;

export const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const enc = (value: string): string => encodeURIComponent(value);

export function renderNotice(notice?: Notice): string {
  if (!notice) return '<div id="notice" aria-live="polite"></div>';
  return `<div id="notice" aria-live="polite"><aside class="notice notice-${notice.kind}" role="status"><strong>${notice.kind === "error" ? "Action needed" : notice.kind === "warn" ? "Heads up" : "Saved"}</strong><span>${escapeHtml(notice.message)}</span>${notice.action ?? ""}</aside></div>`;
}

export const htmxForm =
  'hx-target="#workspace" hx-swap="outerHTML" hx-disable="find button[type=\'submit\']" hx-status:422="target:#notice swap:innerHTML"';

export const htmxDialogForm =
  'hx-target="#workspace" hx-swap="outerHTML" hx-disable="find button[type=\'submit\']" hx-status:422="target:#modal-body swap:innerHTML"';

export function field(
  form: RequestForm,
  name: string,
  maximum: number,
  required = true,
): string {
  const raw = form.get(name);
  if (typeof raw !== "string") {
    if (!required) return "";
    throw new Error(`${name} is required — enter a value and try again`);
  }
  const value = raw.trim();
  if (required && value.length === 0)
    throw new Error(`${name} is required — enter a value and try again`);
  if (value.length > maximum)
    throw new Error(
      `${name} is too long (${value.length}/${maximum}) — shorten it and try again`,
    );
  return value;
}

export async function readForm(request: Request): Promise<RequestForm> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 1_048_576)
    throw new Error("request is larger than 1 MiB — reduce it and try again");
  return request.formData();
}

export function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^-?\d+$/.test(value))
    throw new Error(
      `${name} must be a whole number — correct it and try again`,
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(
      `${name} must be between ${minimum} and ${maximum} — correct it and try again`,
    );
  return parsed;
}

export function parseDate(value: string): number | null {
  if (value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(
      "due date must be a calendar date — correct it and try again",
    );
  const parsed = Date.parse(`${value}T23:59:59.999Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  )
    throw new Error(
      "due date must be a calendar date — correct it and try again",
    );
  return parsed;
}

export function safeId(value: string | undefined, label: string): string {
  if (!value || !/^[0-9A-Z]{32}$/.test(value))
    throw new Error(`invalid ${label} address — return to the previous page`);
  return value;
}
