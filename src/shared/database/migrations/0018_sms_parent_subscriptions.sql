CREATE TABLE "public"."school_sms_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"commission_pct" numeric(5,2) DEFAULT 0 NOT NULL,
	"sms_cap_per_student" integer DEFAULT 60 NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_sms_features_tenant_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "public"."school_sms_features" ADD CONSTRAINT "school_sms_features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_sms_features_tenant" ON "public"."school_sms_features" USING btree ("tenant_id");
--> statement-breakpoint

CREATE TABLE "public"."edutrack_commission_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"total_subscriptions_fcfa" integer DEFAULT 0 NOT NULL,
	"commission_pct" numeric(5,2) NOT NULL,
	"commission_due_fcfa" integer DEFAULT 0 NOT NULL,
	"commission_paid_fcfa" integer DEFAULT 0 NOT NULL,
	"last_payment_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edutrack_commission_records_tenant_month_unique" UNIQUE("tenant_id","period_month")
);
--> statement-breakpoint
ALTER TABLE "public"."edutrack_commission_records" ADD CONSTRAINT "edutrack_commission_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_commission_tenant_month" ON "public"."edutrack_commission_records" USING btree ("tenant_id","period_month");
--> statement-breakpoint

CREATE TABLE "tenant"."parents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"email" varchar(255),
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parents_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE INDEX "idx_parents_phone" ON "tenant"."parents" USING btree ("phone");
--> statement-breakpoint

CREATE TABLE "tenant"."parent_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"unit_price_fcfa" integer NOT NULL,
	"student_count" integer NOT NULL,
	"total_amount_fcfa" integer NOT NULL,
	"duration_months" integer DEFAULT 1 NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"auto_renew_alert" boolean DEFAULT false NOT NULL,
	"renewed_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_subscriptions_status_check" CHECK ("parent_subscriptions"."status" IN ('active', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "tenant"."parent_subscriptions" ADD CONSTRAINT "parent_subscriptions_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "tenant"."parents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant"."parent_subscriptions" ADD CONSTRAINT "parent_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_parent_subs_parent" ON "tenant"."parent_subscriptions" USING btree ("parent_id");
--> statement-breakpoint
CREATE INDEX "idx_parent_subs_status_end" ON "tenant"."parent_subscriptions" USING btree ("status","ends_at");
--> statement-breakpoint

CREATE TABLE "tenant"."parent_student_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_student_links_parent_student_unique" UNIQUE("parent_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "tenant"."parent_student_links" ADD CONSTRAINT "parent_student_links_subscription_id_parent_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "tenant"."parent_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant"."parent_student_links" ADD CONSTRAINT "parent_student_links_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "tenant"."parents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant"."parent_student_links" ADD CONSTRAINT "parent_student_links_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_parent_student_links_student" ON "tenant"."parent_student_links" USING btree ("student_id");
--> statement-breakpoint

CREATE TABLE "tenant"."subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_fcfa" integer NOT NULL,
	"payment_method" varchar(20) DEFAULT 'cash' NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_method_check" CHECK ("subscription_payments"."payment_method" IN ('cash', 'momo_mtn', 'momo_orange'))
);
--> statement-breakpoint
ALTER TABLE "tenant"."subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_parent_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "tenant"."parent_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant"."subscription_payments" ADD CONSTRAINT "subscription_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_sub_payments_sub" ON "tenant"."subscription_payments" USING btree ("subscription_id");
--> statement-breakpoint

CREATE TABLE "tenant"."sms_usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"month" char(7) NOT NULL,
	"sms_sent_count" integer DEFAULT 0 NOT NULL,
	"email_sent_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_usage_log_student_month_unique" UNIQUE("student_id","month")
);
--> statement-breakpoint
ALTER TABLE "tenant"."sms_usage_log" ADD CONSTRAINT "sms_usage_log_subscription_id_parent_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "tenant"."parent_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant"."sms_usage_log" ADD CONSTRAINT "sms_usage_log_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_sms_usage_student_month" ON "tenant"."sms_usage_log" USING btree ("student_id","month");
