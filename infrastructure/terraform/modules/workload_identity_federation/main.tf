/**
 * Workload Identity Federation for GitHub Actions
 *
 * Establishes a keyless authentication path from GitHub Actions OIDC tokens
 * to GCP service accounts. This module is the canonical implementation of
 * CLAUDE.md rule 5 (no SA JSON keys) for CI/CD.
 *
 * Two service accounts are created per environment:
 *   - deploy: write access required to deploy Cloud Run revisions
 *   - plan  : read-only access for `terraform plan` / preview jobs
 *
 * Both SAs trust only OIDC tokens issued for `var.repository`. Pull-request
 * branches and main are not separated at the WIF layer — restrict at the
 * GitHub Actions environment / branch protection layer instead.
 */

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

locals {
  pool_id     = "github-${var.env_name}"
  provider_id = "github-${var.env_name}"

  deploy_sa_id = "gha-deploy-${var.env_name}"
  plan_sa_id   = "gha-plan-${var.env_name}"

  # Subject principal for a specific repository under the pool.
  # `principalSet` matches any token whose `attribute.repository` equals var.repository.
  repo_principal_set = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.repository}"

  deploy_roles = [
    "roles/run.admin",
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
  ]

  plan_roles = [
    "roles/viewer",
    "roles/iam.securityReviewer",
  ]
}

# -----------------------------------------------------------------------------
# Workload Identity Pool + Provider
# -----------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = local.pool_id
  display_name              = "GitHub Actions (${var.env_name})"
  description               = "OIDC pool for GitHub Actions in ${var.repository} (${var.env_name})."
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = local.provider_id
  display_name                       = "GitHub OIDC (${var.env_name})"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.actor"      = "assertion.actor"
  }

  # Hard-restrict tokens to the configured repository. Without an attribute
  # condition GCP refuses to create the provider (defense-in-depth required
  # by Google since 2023).
  attribute_condition = "assertion.repository == \"${var.repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# -----------------------------------------------------------------------------
# Service Accounts
# -----------------------------------------------------------------------------

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = local.deploy_sa_id
  display_name = "GitHub Actions deploy (${var.env_name})"
  description  = "Used by GitHub Actions to deploy Cloud Run / access secrets in ${var.env_name}."
}

resource "google_service_account" "plan" {
  project      = var.project_id
  account_id   = local.plan_sa_id
  display_name = "GitHub Actions plan (${var.env_name})"
  description  = "Read-only SA for terraform plan / preview jobs in ${var.env_name}."
}

# -----------------------------------------------------------------------------
# Project-level role bindings
# -----------------------------------------------------------------------------

resource "google_project_iam_member" "deploy_roles" {
  for_each = toset(local.deploy_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "plan_roles" {
  for_each = toset(local.plan_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.plan.email}"
}

# -----------------------------------------------------------------------------
# WIF -> SA impersonation bindings
#
# Only tokens from the configured repository may impersonate either SA.
# We use `google_service_account_iam_binding` (authoritative) so that drift
# introduced via the console is reverted on the next apply.
# -----------------------------------------------------------------------------

resource "google_service_account_iam_binding" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  members            = [local.repo_principal_set]
}

resource "google_service_account_iam_binding" "plan_wif" {
  service_account_id = google_service_account.plan.name
  role               = "roles/iam.workloadIdentityUser"
  members            = [local.repo_principal_set]
}
