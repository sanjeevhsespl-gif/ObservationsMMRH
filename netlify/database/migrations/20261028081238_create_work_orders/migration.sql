CREATE TABLE "work_order_comments" (
	"id" serial PRIMARY KEY,
	"work_order_id" text NOT NULL,
	"field" text NOT NULL,
	"label" text NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" text PRIMARY KEY,
	"wo_no" text DEFAULT '' NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"upload_complete" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_comments_wo_field_idx" ON "work_order_comments" ("work_order_id","field");--> statement-breakpoint
ALTER TABLE "work_order_comments" ADD CONSTRAINT "work_order_comments_work_order_id_work_orders_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE CASCADE;