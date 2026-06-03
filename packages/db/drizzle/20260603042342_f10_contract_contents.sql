CREATE TABLE "contract_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "uq_contract_contents_contract_content" UNIQUE("contract_id","content_id")
);
--> statement-breakpoint
ALTER TABLE "contract_contents" ADD CONSTRAINT "contract_contents_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_contents" ADD CONSTRAINT "contract_contents_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_contract_contents_contract_id" ON "contract_contents" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "ix_contract_contents_content_id" ON "contract_contents" USING btree ("content_id");