ALTER TABLE "advertisers" ADD COLUMN "portal_company_id" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "portal_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "portal_placement_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_advertisers_portal_company_id" ON "advertisers" USING btree ("portal_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_contracts_portal_contract_id" ON "contracts" USING btree ("portal_contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_ads_portal_placement_id" ON "ads" USING btree ("portal_placement_id");