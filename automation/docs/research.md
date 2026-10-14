# gevico 组织仓库创建与权限自动化调研

调研日期：2026 年 10 月 14 日。

## ipdxco/github-as-code 模板

[ipdxco/github-as-code](https://github.com/ipdxco/github-as-code) 提供通过 PR 管理 GitHub 组织配置的模板，使用 YAML、Terraform 和 GitHub Actions。组织配置文件采用 `github/<组织名称>.yml` 的形式，可对应为 `gevico/repos` 中的 `github/gevico.yml`。[配置机制](https://github.com/ipdxco/github-as-code/blob/master/docs/ABOUT.md)

其创建仓库流程如下：

1. 申请人在 YAML 中添加仓库配置并提交 PR。
2. `Plan` 工作流生成 Terraform 变更计划，并将计划展示在 PR 评论中。
3. 管理员审核仓库配置、权限和变更计划，合并 PR。
4. 默认分支收到合并提交后，`Apply` 工作流重新生成计划，确认与 PR 展示的计划一致，然后执行 `terraform apply`。

实际创建动作由默认分支的 `push` 事件触发。审核与合并要求通过仓库分支保护配置执行。[Plan 工作流](https://github.com/ipdxco/github-as-code/blob/master/.github/workflows/plan.yml)、[Apply 工作流](https://github.com/ipdxco/github-as-code/blob/master/.github/workflows/apply.yml)、[审核配置指引](https://github.com/ipdxco/github-as-code/blob/master/docs/SETUP.md#github-management-repository-protections)

模板实现了 `github_repository`、`github_repository_collaborator`、`github_team` 和 `github_team_repository` 等资源。仓库的个人协作者和团队权限均支持 `pull`、`triage`、`push`、`maintain`、`admin`。配置还可以包含可见性、描述、模板仓库和分支保护。[资源实现](https://github.com/ipdxco/github-as-code/blob/master/terraform/resources.tf)、[完整配置示例](https://github.com/ipdxco/github-as-code/blob/master/docs/EXAMPLE.yml)

当前模板默认启用 `github_repository` 和 `github_branch_protection`。用于仓库权限管理时，需要在 `terraform/locals_override.tf` 中启用 `github_repository_collaborator` 和 `github_team_repository`；按团队名称配置权限时，还需启用 `github_team` 并导入或创建相应团队。[默认资源类型](https://github.com/ipdxco/github-as-code/blob/master/terraform/locals_override.tf)、[团队资源引用](https://github.com/ipdxco/github-as-code/blob/master/terraform/resources.tf#L179)

部分仓库属性列入 `lifecycle.ignore_changes`，可在创建时设置；持续管理这些属性需要调整对应配置。个人和团队仓库权限资源的 `ignore_changes` 为空。[属性管理配置](https://github.com/ipdxco/github-as-code/blob/master/terraform/resources_override.tf)、[权限资源配置](https://github.com/ipdxco/github-as-code/blob/master/terraform/resources.tf#L103)

项目尚未归档，默认分支最新提交日期为 2026 年 5 月 10 日。整体复用许可证尚未明确，询问许可证的 Issue 仍处于开放状态。[最新提交](https://github.com/ipdxco/github-as-code/commit/eaa899daff9336aba205ab0c4652418d0bca3ec5)、[许可证问题](https://github.com/ipdxco/github-as-code/issues/247)

## ipfs/github-mgmt 使用实例

[ipfs/github-mgmt](https://github.com/ipfs/github-mgmt) 使用上述模板管理 `ipfs` 组织。其资源配置启用了仓库创建、个人协作者、团队、团队成员、团队仓库权限、分支保护及仓库文件。[启用的资源类型](https://github.com/ipfs/github-mgmt/blob/master/terraform/locals_override.tf)

该仓库的 `Apply` 工作流在默认分支 `master` 收到提交后执行 Terraform，包含合并后计划与审核计划的一致性检查。已合并的 PR 包括为 `devrel` 团队配置 `ipfs-desktop` 写入权限。[Apply 工作流](https://github.com/ipfs/github-mgmt/blob/master/.github/workflows/apply.yml)、[权限变更 PR](https://github.com/ipfs/github-mgmt/pull/262)

该仓库目前已经归档。README 标明自 2026 年 9 月 1 日起停止维护，可作为历史使用实例和配置参考。[当前 README](https://github.com/ipfs/github-mgmt/blob/master/README.md)、[仓库状态](https://api.github.com/repos/ipfs/github-mgmt)

## 持续维护的相关实现

`integrations/terraform-provider-github` 负责创建仓库与管理权限资源，许可证为 MIT。最新稳定版本为 2026 年 7 月 8 日发布的 `v6.13.0`，默认分支在 2026 年 10 月 7 日仍有修复提交。它提供资源管理组件；PR 申请校验、审核和 GitHub Actions 编排由管理仓库实现。[版本发布](https://github.com/integrations/terraform-provider-github/releases/tag/v6.13.0)、[修复提交](https://github.com/integrations/terraform-provider-github/commit/20f916cb020eabb5d4f2e29d3ea0e19a1ebbab53)、[许可证](https://github.com/integrations/terraform-provider-github/blob/main/LICENSE)

## gevico 采用这套流程的配置条件

`gevico/repos` 采用声明配置与 PR 审核流程。申请人使用仓库 skill 生成 `repositories/<name>.yaml`，管理员审核并合并 PR，CI 使用 Terraform GitHub Provider 创建 `gevico/<目标仓库>` 并设置批准的个人或团队权限。

- **申请入口与触发分支**：仓库 skill 将自然语言需求转换为每个目标仓库的 YAML。管理仓库使用 `main`，PR 校验与合并后执行分别由 Request 和 Apply 工作流承担。
- **资源与现有配置**：初始化 Terraform 后端和已应用提交记录；既有仓库经过管理员核验与导入后加入管理清单。个人与团队直接授权统一使用 `github_repository_collaborators`。[权限资源说明](https://github.com/integrations/terraform-provider-github/blob/v6.13.0/docs/resources/repository_collaborators.md)
- **审核要求**：在管理仓库配置必需的 PR 审核与检查，通过分支保护要求审核通过后才能合并。公开组织仓库可使用 GitHub Free 的分支保护；私有组织仓库使用该功能需要相应付费套餐。[GitHub 分支保护说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- **GitHub 凭证**：模板采用分别用于读取和写入的 GitHub App，并要求安装到组织的全部仓库。GitHub Actions 自动提供的 `GITHUB_TOKEN` 权限限定在工作流所在仓库；组织仓库创建和跨仓库授权使用另外配置的 GitHub App 凭证。[模板凭证配置](https://github.com/ipdxco/github-as-code/blob/master/docs/SETUP.md#github-app)、[GITHUB_TOKEN 权限范围](https://docs.github.com/en/actions/concepts/security/github_token)
- **状态存储**：使用 `terraform-backend-git v0.1.12` 将 SOPS/age 加密状态保存到私有 `gevico/repos-state`，通过远程 Git 锁分支锁定状态。PR 预览记录使用 age 加密后上传到 Actions artifacts，执行前核验受信任工作流的来源与内容。[Git 后端实现](https://github.com/plumber-cd/terraform-backend-git/tree/v0.1.12)、[Actions artifact SDK](https://github.com/actions/toolkit/tree/main/packages/artifact)
- **持续管理范围**：管理已登记仓库的属性、默认分支、直接个人与团队授权及分支规则。预览与执行均读取实际 GitHub 状态，并检查执行变更与审核目标的一致性。初始化模板和仓库身份保持稳定。

## GitHub 资源中的持久状态

[plumber-cd/terraform-backend-git](https://github.com/plumber-cd/terraform-backend-git) 的 `v0.1.12` 于 2026 年 9 月 19 日发布，项目采用 Apache-2.0 许可证，提供 Terraform HTTP 后端、Git 远程锁定、状态版本和 SOPS/age 加密。后端可在 runner 内运行，任务结束后终止。[版本发布](https://github.com/plumber-cd/terraform-backend-git/releases/tag/v0.1.12)、[锁定实现](https://github.com/plumber-cd/terraform-backend-git/blob/v0.1.12/storages/git/client.go)、[age 配置](https://github.com/plumber-cd/terraform-backend-git/blob/v0.1.12/crypt/sops/age.go)

本项目使用 Go 编译时的文件映射配置提交身份，使状态提交从 Git 配置读取姓名和邮箱，并包含 `Signed-off-by`。依赖的状态读写、锁定和加密实现由上述后端提供。

[age-encryption](https://github.com/FiloSottile/typage) 提供 JavaScript 的 age 文件加密和解密。GitHub 官方 `@actions/artifact` 提供 artifact 上传、跨运行下载和摘要核验。预览上传的 artifact 为加密文件，执行任务保存经核验的审核记录到私有仓库，支持长期重试。[加密 API](https://github.com/FiloSottile/typage#usage)、[artifact API](https://github.com/actions/toolkit/blob/main/packages/artifact/README.md)

私有仓库中的加密审核和执行记录通过 Git blob API 读取原始字节，接口返回 Base64 编码的 Git 对象内容。[Git blob API](https://docs.github.com/en/rest/git/blobs#get-a-blob)
