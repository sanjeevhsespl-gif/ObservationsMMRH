import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// One row per uploaded PDF work order. The PDF bytes live in Netlify Blobs
// (store "work-order-pdfs", keys "<id>/part-<n>"), split into upload chunks.
export const workOrders = pgTable("work_orders", {
  id: text().primaryKey(),
  woNo: text("wo_no").notNull().default(""),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull(),
  partCount: integer("part_count").notNull(),
  uploadComplete: boolean("upload_complete").notNull().default(false),
  status: text().notNull().default("draft"), // draft | submitted
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
});

// One comment per work order field (a standard section or a PDF form text field).
export const workOrderComments = pgTable(
  "work_order_comments",
  {
    id: serial().primaryKey(),
    workOrderId: text("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    field: text().notNull(),
    label: text().notNull(),
    page: integer(),
    text: text().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("work_order_comments_wo_field_idx").on(t.workOrderId, t.field)]
);
