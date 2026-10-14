# 已执行的验证

验证日期：2026 年 10 月 14 日。

## GitHub Actions

[Check 执行记录](https://github.com/gevico/repos/actions/runs/38496289498) 在 GitHub 托管 Linux runner 上完成配置校验、程序测试、Git 后端构建、Terraform 格式与配置检查。

该任务从 `automation/` 安装依赖并执行管理程序，上传真实的 age 加密 artifact，通过认证的 GitHub REST API 下载，核验 SHA-256 摘要，并解密核对该任务的提交 SHA、运行 ID 和政策摘要。检查使用任务内生成的独立加密密钥。

## 目录和仓库 skill

一级可见目录为 `automation/` 和 `repositories/`。实现、依赖、政策、Schema、Terraform 和测试位于 `automation/`；申请 YAML 和使用文档位于 `repositories/`。GitHub Actions 与仓库 skill 的入口保留在 `.github/` 和 `.agents/`。

已执行 `repo-request` 的配置生成步骤：生成公开仓库声明，指定真实用户 `zevorn` 和真实团队 `ai_infra-pigpig-runrun`，通过 Schema、政策和 GitHub 在线校验。CLI 从实现目录执行时，仍按项目根目录解析申请目录和输出路径。

## 真实 GitHub 资源

本地集成验证使用两个已安装的 GitHub App、Terraform 1.12.2、GitHub Provider 6.13.0，以及私有 [gevico/repos-state](https://github.com/gevico/repos-state)。验证目标为 [gevico/repos-integration-20261014](https://github.com/gevico/repos-integration-20261014)，仓库 ID 为 `1417660329`。

已核验的结果：

- 创建公开仓库，默认分支为 `main`，仓库描述和主题与声明一致。
- `zevorn` 保留 `admin` 权限，默认分支规则要求 PR 审核并保护分支。
- 真实团队 `ai_infra-pigpig-runrun` 取得 `push` 权限，随后调整为 `triage`，最后撤销直接授权。
- 只读 App 读取和解密状态，并生成无变更计划；远程状态写入被拒绝。
- 状态文件使用 SOPS/age 加密，审核及执行记录使用 age 加密；加密记录通过 Git blob API 读取原始字节。
- 重复生成计划得到无变更结果，损坏的加密审核记录被拒绝。
- 两个独立后端进程竞争同一远程锁，第二个进程返回 HTTP 409 和当前锁 ID；验证结束后锁被释放。
- 状态提交使用实际 Git 配置中的姓名和邮箱，包含 `Signed-off-by`。

验证资源使用独立状态路径 `integration/20261014/terraform.tfstate`。该仓库用于集成验证，申请目录中的生产声明保持为空。

## 生产流程的运行条件

自动化代码需要通过管理仓库的必需审核和检查合并到 `main`。随后启用 `AUTOMATION_ENABLED`，由 Apply 初始化生产状态，再提交真实的仓库配置 PR，核验从预览、审核到合并后创建的 Actions 流程。
