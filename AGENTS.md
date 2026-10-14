# Repository instructions

Read `automation/docs/documentation-guidelines.md` before changing documentation, and read `automation/policy.yml` plus `automation/schema/repository.schema.json` before changing repository requests.

The application runs in GitHub-hosted Actions. GitHub resource changes use Terraform's `integrations/github` Provider. Request data is parsed with `yaml` and validated with Ajv. Keep privileged workflows on trusted code and treat PR files as data.

Repository skills live in `.agents/skills/`. The `repo-request` skill creates a local request and validates it. Publishing a PR requires the user's instruction to submit it.

Implementation files, dependencies and documentation live in `automation/`. The `repositories/` directory contains only actual repository declaration YAML files. Keep `.github/` and `.agents/` at the checkout root for discovery. Commands in documentation run from the checkout root.

Use `npm --prefix automation run check` for local validation. Use `terraform -chdir=automation/terraform fmt -check` and `terraform -chdir=automation/terraform validate` for Terraform changes. Real GitHub integration checks use explicitly identified resources; report the actual result.
