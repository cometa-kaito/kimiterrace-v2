# Module: `workload_identity_federation`

Provisions a GitHub Actions → GCP keyless authentication path per environment.

## What it creates

- 1 Workload Identity Pool (`github-<env>`)
- 1 OIDC Provider on the pool, restricted to `var.repository`
- 2 service accounts:
  - `gha-deploy-<env>@…` — `run.admin`, `cloudsql.client`, `secretmanager.secretAccessor`
  - `gha-plan-<env>@…`   — `viewer`, `iam.securityReviewer`
- `roles/iam.workloadIdentityUser` bindings allowing only tokens from
  `principalSet: …/attribute.repository/<var.repository>` to impersonate each SA.

## Why two SAs

Splitting deploy from read-only follows least-privilege. Pull-request CI jobs
(plan / preview) should use the plan SA; deploy jobs on `main` use the deploy SA.

## Inputs

See [`variables.tf`](variables.tf). Required: `project_id`, `repository`, `env_name`.

## Outputs

See [`outputs.tf`](outputs.tf). The two most useful in CI:

- `provider_name` → `workload_identity_provider`
- `deploy_sa_email` / `plan_sa_email` → `service_account`

## Related

- CLAUDE.md rule 5 (no SA JSON keys)
- CLAUDE.md rule 8 (no console-only changes)
- [docs/runbooks/github-actions-auth.md](../../../../docs/runbooks/github-actions-auth.md)
