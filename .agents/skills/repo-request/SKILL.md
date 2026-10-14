---
name: repo-request
description: Turn a natural-language request into a validated gevico repository YAML file. Use for creating a repository request or updating its user and team permissions in a cloned gevico/repos checkout.
---

# Repository request

Use the current checkout's `automation/policy.yml`, `automation/schema/repository.schema.json`, and `repositories/README.md` as the configuration contract. Resolve the checkout root from this skill's location. Run commands from that root. Implementation and dependencies are under `automation/`; generated declarations remain under `repositories/`.

Interpret the user's language into a repository name, purpose, visibility, maintainers, user permissions, team permissions, and an optional template. Use public visibility unless the user requests private. Translate read/write to `pull`/`push`; maintainer maps to `maintain`. The policy's administrator users and teams keep their `admin` role.

Use explicit GitHub usernames and existing team slugs. When the requester should maintain the repository, resolve their username with `gh api user --jq .login` if authenticated. Ask for any necessary missing identity or ambiguous permission; never invent a person, team, or authorization. Read private-repository capability and allowed teams/templates from the actual policy.

For a new request, use `node automation/scripts/repos.mjs request` with the extracted fields. It renders validated YAML to stdout. Write that output to `repositories/<name>.yaml` with the environment's file editing tool. For structured or extensive access lists, prepare a JSON input file in the checkout's excluded `.work/` directory and use `--json-file`. Paths supplied to `--json-file`, `--directory` and `--output` are relative to the checkout root. Run `npm --prefix automation ci` when dependencies are absent.

For an existing request, read its current file and preserve unrelated settings. Apply the requested permission changes with a file editing tool. Repository names and initialization templates are immutable; configuration deletion is prohibited.

Run `npm --prefix automation run validate`. When GitHub authentication is available, also run `npm --prefix automation run validate -- --online` to check real users, teams and templates. Validation reports authorization and visibility constraints; resolve them before publishing.

Return the generated file and explain its concrete access choices. If the user requests submission, create a branch, commit only the intended request with `git commit -s`, push it and open a PR to `gevico/repos`. Use the configured Git author and the project's contribution rules. Follow the user's authorized scope for external operations. Repository creation occurs after administrator review and merge.

Examples of requests this skill handles:

- “在 gevico 下创建 qemu-plugins，用来研究 QEMU 插件，设为公开，由 zevorn 管理。”
- “把这个仓库的 ai_infra-pigpig-runrun 团队权限设置为维护权限，保留其他授权。”

The skill uses the coding agent interpreting the request. Its work is local configuration generation and PR preparation; CI uses Terraform and the GitHub API.
