# 贡献流程

在克隆后的项目根目录运行 `npm --prefix automation ci`，阅读 `automation/policy.yml` 和 `automation/docs/documentation-guidelines.md`。

仓库申请通过 `repositories/<name>.yaml` 提交。程序、工作流与文档变更通过独立维护 PR 提交。申请和维护 PR 都遵循 CODEOWNERS 审核要求。

运行 `npm --prefix automation run check`。修改 Terraform 时执行 `terraform -chdir=automation/terraform fmt -check`、`terraform -chdir=automation/terraform init -backend=false -input=false -lockfile=readonly` 和 `terraform -chdir=automation/terraform validate`。

使用当前 Git 配置中的作者信息，通过 `git commit -s` 添加 `Signed-off-by`。分支名称采用描述内容的名称，例如 `request/qemu-plugins` 或 `feature/request-validation`。
