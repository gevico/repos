---
name: repo-request
description: Generate validated gevico repository YAML from natural language for creation, Fork, mirror copies, existing repository access, archiving, deletion or restoration in a cloned gevico/repos checkout.
---

# Repository request

Use the current checkout's `automation/policy.yml`, `automation/schema/repository.schema.json`, and `automation/docs/requesting.md` as the configuration contract. Resolve the checkout root from this skill's location. Run commands from that root. Implementation, dependencies and documentation are under `automation/`; `repositories/` contains only actual repository declaration YAML files.

Interpret the user's language into a repository name, purpose, visibility, maintainers, permissions, source repository, README template, license and requested lifecycle status. Use public visibility unless the user requests private. Translate read/write to `pull`/`push`; maintainer maps to `maintain`. Preserve the policy's administrator and protected repository user permissions.

Use explicit GitHub usernames and existing team slugs. When the requester should maintain the repository, resolve their username with `gh api user --jq .login` if authenticated. Ask for any necessary missing identity or ambiguous permission; never invent a person, team, or authorization. Read private-repository capability and allowed teams/templates from the actual policy.

For a new repository, use `node automation/scripts/repos.mjs request` with the extracted fields. `--readme-template` selects `project`, `library` or `minimal`; `--license` takes a key from the policy's `allowed_licenses`. A license is optional and fixed after registration, so when the user has not mentioned one for a new ordinary repository, ask whether they want no license or one of the allowed keys. For a Fork, add `--fork owner/repository`; the command reads and binds the real source ID and default branch. Forks inherit their upstream license. Consult [requesting.md](../../../automation/docs/requesting.md) for source and initialization constraints.

For a one-time copy of an external Git repository, add `--mirror URL` with the source's HTTPS clone URL ending in `.git`; the host must be listed in the policy's `allowed_mirror_hosts`. The command reads the real default branch and, for github.com sources, binds the public source repository ID. A mirror has no fork relationship and does not sync afterwards; it copies the branches and tags shown in the PR preview, starts with GitHub Actions disabled, and keeps the source README and license, so do not add `--readme-template` or `--license`. Use Fork when the user wants the GitHub fork relationship; use mirror for non-GitHub sources or an independent copy.

For an existing GitHub repository without a declaration, use `node automation/scripts/repos.mjs existing --name NAME --user USER:ROLE` or `--team TEAM:ROLE`. It captures the current ID and direct access, then applies the requested changes. `--remove-user` and `--remove-team` revoke explicit assignments. Keep unrelated access entries. This mode preserves repository contents, settings and branch names.

For archiving, deleting or restoring a declared repository, read its current YAML and [lifecycle.md](../../../automation/docs/lifecycle.md). Use `node automation/scripts/repos.mjs lifecycle --name NAME --status archived|deleted|active`. The command reads the real target ID and renders the complete declaration. Preserve its other fields. Use the file editing tool to move the YAML to `repositories/archive/NAME.yaml` for archived/deleted, or `repositories/NAME.yaml` for active. Keep deleted declarations as records. Explain the exact target and requested status; execution occurs through the approved PR.

Commands render YAML to stdout. Save it with the environment's file editing tool. For extensive access lists, prepare a JSON input file in the checkout's excluded `.work/` directory and use `request --json-file`. Paths supplied to `--json-file`, `--directory` and `--output` are relative to the checkout root. Run `npm --prefix automation ci` when dependencies are absent.

For an existing declaration, read its current file and preserve unrelated settings. Apply requested permission changes with a file editing tool. Names, modes, initialization settings and registered IDs are immutable. Submit lifecycle changes separately from new declarations or permission changes.

Run `npm --prefix automation run validate`. When GitHub authentication is available, also run `npm --prefix automation run validate -- --online` to check real users, teams and templates. Validation reports authorization and visibility constraints; resolve them before publishing.

Return the generated file and explain the concrete operation and access choices. If the user requests submission, create a descriptive branch, commit only the intended request with `git commit -s`, push it and open a PR to `gevico/repos` using the requester's authenticated account. Use the configured Git author and the project's contribution rules. Follow the user's authorized scope for external operations. Actions perform the approved operation after review and merge.

Examples of requests this skill handles:

- “在 gevico 下创建 qemu-plugins，用来研究 QEMU 插件，设为公开，由 zevorn 管理。”
- “把这个仓库的 ai_infra-pigpig-runrun 团队权限设置为维护权限，保留其他授权。”
- “给已有的 GW100 仓库申请 bbbbbq 的管理权限。”
- “Fork octocat/Hello-World 到 gevico，仓库叫 hello-world-study，由我维护。”
- “把 https://gitlab.com/qemu-project/qemu.git 镜像到 gevico，仓库叫 qemu-mirror，由我维护。”
- “把 demo 归档。”
- “删除 demo，把申请 YAML 保存在归档目录。”

The skill uses the coding agent interpreting the request. Its work is local configuration generation and PR preparation; CI uses Terraform and the GitHub API.
