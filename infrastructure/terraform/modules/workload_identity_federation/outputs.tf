output "pool_id" {
  description = "Workload Identity Pool short ID."
  value       = google_iam_workload_identity_pool.github.workload_identity_pool_id
}

output "pool_name" {
  description = "Fully-qualified Workload Identity Pool resource name."
  value       = google_iam_workload_identity_pool.github.name
}

output "provider_name" {
  description = "Fully-qualified provider resource name. Use as `workload_identity_provider` input in google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_sa_email" {
  description = "Email of the deploy SA. Use as `service_account` input in google-github-actions/auth for deploy jobs."
  value       = google_service_account.deploy.email
}

output "plan_sa_email" {
  description = "Email of the plan/read-only SA. Use for terraform plan / preview jobs."
  value       = google_service_account.plan.email
}
