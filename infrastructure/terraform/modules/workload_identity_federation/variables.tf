variable "project_id" {
  type        = string
  description = "GCP project ID where the WIF pool and service accounts are created."
}

variable "repository" {
  type        = string
  description = "GitHub repository in `owner/name` form (e.g. `cometa-kaito/kimiterrace-v2`). Only OIDC tokens from this repository can impersonate the SAs."

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.repository))
    error_message = "repository must be in `owner/name` form."
  }
}

variable "env_name" {
  type        = string
  description = "Environment short name (dev | staging | prod). Used to namespace pool / provider / SA IDs."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env_name)
    error_message = "env_name must be one of: dev, staging, prod."
  }
}
