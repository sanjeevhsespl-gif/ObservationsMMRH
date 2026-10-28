import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { workOrderComments, workOrders } from "../../db/schema.js";

// Uploads are split into chunks so each request stays well under the
// synchronous function payload limit. The client reads chunkSize from the API.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_COMMENTS = 100;
const MAX_COMMENT_CHARS = 4000;
const MAX_KEY_CHARS = 200;

type WorkOrderRow = typeof workOrders.$inferSelect;
type CommentRow = typeof workOrderComments.$inferSelect;

const pdfStore = () => getStore({ name: "work-order-pdfs", consistency: "strong" });
const partKey = (id: string, n: number) => `${id}/part-${n}`;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

// Strip control characters (keeping tabs/newlines) and clamp length.
function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function serialize(wo: WorkOrderRow, comments: CommentRow[]) {
  return {
    id: wo.id,
    woNo: wo.woNo,
    fileName: wo.fileName,
    fileSize: wo.fileSize,
    partCount: wo.partCount,
    chunkSize: CHUNK_BYTES,
    status: wo.status,
    createdAt: wo.createdAt,
    updatedAt: wo.updatedAt,
    submittedAt: wo.submittedAt,
    comments: comments
      .filter((c) => c.workOrderId === wo.id)
      .map((c) => ({ field: c.field, label: c.label, page: c.page, text: c.text, updatedAt: c.updatedAt })),
  };
}

async function loadOne(id: string) {
  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, id));
  if (!wo) return null;
  const comments = await db
    .select()
    .from(workOrderComments)
    .where(eq(workOrderComments.workOrderId, id))
    .orderBy(asc(workOrderComments.id));
  return { wo, comments };
}

function expectedPartSize(wo: WorkOrderRow, n: number) {
  return n < wo.partCount - 1 ? CHUNK_BYTES : wo.fileSize - CHUNK_BYTES * (wo.partCount - 1);
}

async function list() {
  const rows = await db
    .select()
    .from(workOrders)
    .where(eq(workOrders.uploadComplete, true))
    .orderBy(desc(workOrders.createdAt));
  const ids = rows.map((r) => r.id);
  const comments = ids.length
    ? await db
        .select()
        .from(workOrderComments)
        .where(inArray(workOrderComments.workOrderId, ids))
        .orderBy(asc(workOrderComments.id))
    : [];
  return json({ workOrders: rows.map((r) => serialize(r, comments)), maxFileBytes: MAX_FILE_BYTES });
}

async function create(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return fail(400, "Invalid JSON body.");
  const fileName = cleanText(body.fileName, 255);
  const fileSize = Number(body.fileSize);
  if (!fileName || !/\.pdf$/i.test(fileName)) return fail(400, "Only PDF files are supported.");
  if (!Number.isInteger(fileSize) || fileSize <= 0) return fail(400, "The file is empty.");
  if (fileSize > MAX_FILE_BYTES) return fail(413, "Only PDF files up to 20 MB are supported.");

  const [wo] = await db
    .insert(workOrders)
    .values({
      id: crypto.randomUUID(),
      woNo: cleanText(body.woNo, 50),
      fileName,
      fileSize,
      partCount: Math.ceil(fileSize / CHUNK_BYTES),
    })
    .returning();
  return json(serialize(wo, []), 201);
}

async function putPart(req: Request, wo: WorkOrderRow, n: number) {
  if (wo.uploadComplete) return fail(409, "This upload is already complete.");
  if (!Number.isInteger(n) || n < 0 || n >= wo.partCount) return fail(400, "Invalid part number.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength !== expectedPartSize(wo, n)) return fail(400, "Upload chunk has an unexpected size.");
  if (n === 0 && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    return fail(415, "This file is not a valid PDF.");
  }
  await pdfStore().set(partKey(wo.id, n), bytes.buffer);
  return json({ ok: true, part: n });
}

async function getPart(wo: WorkOrderRow, n: number) {
  if (!Number.isInteger(n) || n < 0 || n >= wo.partCount) return fail(400, "Invalid part number.");
  const data = await pdfStore().get(partKey(wo.id, n), { type: "arrayBuffer" });
  if (!data) return fail(404, "PDF data not found.");
  return new Response(data, {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=3600" },
  });
}

async function complete(wo: WorkOrderRow) {
  const { blobs } = await pdfStore().list({ prefix: `${wo.id}/` });
  const have = new Set(blobs.map((b) => b.key));
  for (let n = 0; n < wo.partCount; n++) {
    if (!have.has(partKey(wo.id, n))) return fail(409, `Upload incomplete: part ${n + 1} of ${wo.partCount} is missing.`);
  }
  const [updated] = await db
    .update(workOrders)
    .set({ uploadComplete: true, updatedAt: new Date() })
    .where(eq(workOrders.id, wo.id))
    .returning();
  return json(serialize(updated, []));
}

async function update(req: Request, wo: WorkOrderRow) {
  if (!wo.uploadComplete) return fail(409, "Finish uploading the PDF before saving comments.");
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.comments)) return fail(400, "Expected a comments array.");
  if (body.comments.length > MAX_COMMENTS) return fail(400, `At most ${MAX_COMMENTS} comments per work order.`);

  const byField = new Map<string, { field: string; label: string; page: number | null; text: string }>();
  for (const c of body.comments) {
    const field = cleanText(c?.field, MAX_KEY_CHARS);
    const text = cleanText(c?.text, MAX_COMMENT_CHARS);
    if (!field || !text) continue;
    const page = Number.isInteger(c?.page) && c.page > 0 ? c.page : null;
    byField.set(field, { field, label: cleanText(c?.label, MAX_KEY_CHARS) || field, page, text });
  }
  const comments = [...byField.values()];
  const now = new Date();

  // Upsert the submitted fields, then drop any field that was cleared.
  for (const c of comments) {
    await db
      .insert(workOrderComments)
      .values({ workOrderId: wo.id, ...c, updatedAt: now })
      .onConflictDoUpdate({
        target: [workOrderComments.workOrderId, workOrderComments.field],
        set: { label: c.label, page: c.page, text: c.text, updatedAt: now },
      });
  }
  const keep = comments.map((c) => c.field);
  await db
    .delete(workOrderComments)
    .where(
      keep.length
        ? and(eq(workOrderComments.workOrderId, wo.id), notInArray(workOrderComments.field, keep))
        : eq(workOrderComments.workOrderId, wo.id)
    );

  const submit = body.submit === true;
  await db
    .update(workOrders)
    .set({
      woNo: body.woNo === undefined ? wo.woNo : cleanText(body.woNo, 50),
      status: submit ? "submitted" : "draft",
      submittedAt: submit ? now : null,
      updatedAt: now,
    })
    .where(eq(workOrders.id, wo.id));

  const fresh = await loadOne(wo.id);
  return json(serialize(fresh!.wo, fresh!.comments));
}

async function remove(wo: WorkOrderRow) {
  const store = pdfStore();
  for (let n = 0; n < wo.partCount; n++) await store.delete(partKey(wo.id, n));
  await db.delete(workOrders).where(eq(workOrders.id, wo.id));
  return json({ ok: true });
}

export default async (req: Request, context: Context) => {
  try {
    const { id, part } = context.params;
    const { pathname } = new URL(req.url);

    if (!id) {
      if (req.method === "GET") return await list();
      if (req.method === "POST") return await create(req);
      return fail(405, "Method not allowed.");
    }

    const found = await loadOne(id);
    if (!found) return fail(404, "Work order not found.");
    const { wo, comments } = found;

    if (part !== undefined) {
      const n = Number(part);
      if (req.method === "PUT") return await putPart(req, wo, n);
      if (req.method === "GET") return await getPart(wo, n);
      return fail(405, "Method not allowed.");
    }

    if (pathname.endsWith("/complete")) {
      return req.method === "POST" ? await complete(wo) : fail(405, "Method not allowed.");
    }

    if (req.method === "GET") return json(serialize(wo, comments));
    if (req.method === "PUT") return await update(req, wo);
    if (req.method === "DELETE") return await remove(wo);
    return fail(405, "Method not allowed.");
  } catch (err) {
    console.error("work-orders API error", err);
    return fail(500, "Something went wrong on the server. Please try again.");
  }
};

export const config: Config = {
  path: [
    "/api/work-orders",
    "/api/work-orders/:id",
    "/api/work-orders/:id/complete",
    "/api/work-orders/:id/parts/:part",
  ],
};
