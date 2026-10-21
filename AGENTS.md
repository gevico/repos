# Repository instructions

Read `automation/docs/documentation-guidelines.md` before changing documentation, and read `automation/policy.yml` plus `automation/schema/repository.schema.json` before changing repository requests.

The application runs in GitHub-hosted Actions. Repository settings, files and access use Terraform's `integrations/github` Provider. Fork initialization uses GitHub's official Fork API and records the returned repository ID before Terraform import. Mirror initialization creates an empty repository with the REST API, disables its Actions, pushes the reviewed source branches and tags with git, and records the repository ID before Terraform import. Request data is parsed with `yaml` and validated with Ajv. Keep privileged workflows on trusted code and treat PR files as data.

Repository skills live in `.agents/skills/`. The `repo-request` skill creates a local request and validates it. Publishing a PR requires the user's instruction to submit it.

Implementation files, dependencies and documentation live in `automation/`. The `repositories/` directory contains only actual repository declaration YAML files. Keep `.github/` and `.agents/` at the checkout root for discovery. Commands in documentation run from the checkout root.

Use `npm --prefix automation run check` for local validation. Use `terraform -chdir=automation/terraform fmt -check` and `terraform -chdir=automation/terraform validate` for Terraform changes. Real GitHub integration checks use explicitly identified resources; report the actual result.
