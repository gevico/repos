terraform {
  required_version = "~> 1.12.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "6.13.0"
    }
  }

  backend "http" {}
}

provider "github" {
  owner             = var.organization
  write_delay_ms    = 500
  read_delay_ms     = 100
  parallel_requests = false
}
