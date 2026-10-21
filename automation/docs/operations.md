# 运行与恢复

## 查询结果

申请 PR 的 Request 评论展示已核验配置对应的 Terraform 操作。Apply 成功后更新评论并在工作流摘要中展示目标仓库链接、仓库 ID 和等待接受的邀请。

申请配置修改后重新执行预览，并按分支规则重新审核。Apply 核验通过后，在私有 `gevico/repos-state` 的 `records/applied.json.age` 中记录合并提交和资源结果。文件使用 age 加密。

## 执行失败

检查 Actions 日志中的具体失败步骤和错误信息。修正权限、凭证或部署参数后，可重新运行同一 `main` 提交的 Apply。Terraform 从持久状态读取已经完成的资源，重新生成剩余操作。

重新执行的计划须与已审核目标相符。计划包含额外的属性或授权变化时，刷新实际状态并通过新的配置 PR 处理。上一条提交失败时，后续申请的必需预览检查保持失败，直到先前提交完成。

## 同名仓库与导入

GitHub 中已经存在但未登记到状态的同名仓库会产生冲突。管理员先核验仓库归属、直接授权和当前分支规则，再准备完整声明并导入。

导入需要真实的写入 GitHub App 安装令牌、`STATE_AGE_KEY` 和 `STATE_AGE_RECIPIENT`。后端使用 `gevico/repos-state` 的 `main` 分支。先运行本地配置校验和 Terraform 输入生成：

```bash
node automation/scripts/repos.mjs render --output .work/import/requests.auto.tfvars.json
```

使用与 Apply 相同的 `StateStore.open()` 和 `prepareTerraform()` 初始化工作目录，通过 `run()` 传递该会话的 `env` 执行官方 `terraform import`，并在结束时调用 `store.close()`。资源地址使用 `github_repository.managed["仓库名称"]`、`github_branch_default.managed["仓库名称"]` 和 `github_repository_collaborators.managed["仓库名称"]`。已有同名 ruleset 根据真实 ruleset ID 导入到 `github_repository_ruleset.managed["仓库名称"]`。

导入后运行计划，核验实际差异，再完成审核记录与应用流程。导入操作须在组织写入任务停止期间执行，保持状态锁定。

## 状态与资源保护

名称、模式、初始化配置和登记 ID 保持稳定。单纯移除申请文件与资源替换会被拒绝；归档和删除通过保留完整 YAML 的生命周期 PR 执行。删除需要明确 `status: deleted`、准确数字 ID、已经保存的 `archive_on_destroy=false` 策略和对应审核记录。[生命周期规则](lifecycle.md)

状态使用 SOPS/age 加密后保存到私有仓库的 `gevico/repos/terraform.tfstate`。Git 提交保存状态版本，远程 `locks/gevico/repos/terraform.tfstate` 分支提供原子锁定。Actions concurrency 同时限制组织写入任务。

恢复时先停止组织写入任务，核验所选 Git 版本对应的实际资源，在受信任后端会话中解密并使用官方 `terraform state push` 恢复，再读取最新实际资源并生成计划。恢复后的仓库 ID 必须与真实仓库 ID 一致。加密密钥备份需要同时保留。

工作流中断可能留下锁分支。确认相关 Apply 已全部终止，读取锁中的 ID、操作和时间后，再使用后端文档中的人工解锁流程。锁分支由 Git 后端创建和删除；普通申请不具备解锁权限。

管理员可以在配置写入 App 临时令牌和对应 age 密钥的受信任环境中运行 `npm --prefix automation run backend:build` 与 `npm --prefix automation run backend:check`。检查会读取真实状态，让两个独立后端进程竞争同一远程锁，核验 HTTP 409 和锁持有者 ID，并释放检查创建的锁。状态内容保持不变。

PR 审核 artifact 保留 90 天。合并前记录过期时，重新运行 Request 并审核最新预览。Apply 首次读取并核验 artifact 后，将加密审核记录保存到 `records/reviews/<PR>/<head>.json.age`，同一批准提交的重试读取该持久记录。

## 权限和邀请

直接权限以已审核配置为准。GitHub 组织所有者、组织默认权限和团队继承可能提高有效权限。外部用户收到邀请时，等待用户接受；任务报告该邀请的真实状态。

已有仓库可以使用 `mode: existing` 的声明和 PR 完成导入与权限申请。CLI 读取现有直接授权，保留用户没有要求修改的条目。已有仓库的默认分支、仓库属性和规则保持现状。

## Fork 凭证提醒

Credentials 每天检查 `FORK_USER_TOKEN`。身份或组织权限检查失败时，在管理仓库创建带 `@zevorn` 的 Issue；Apply 遇到相同凭证错误也使用该 Issue。更新 production secret 后运行 Credentials，核验成功会关闭对应提醒。GitHub 限流、网络错误和来源仓库政策错误按实际错误处理。

Fork 初始化请求和返回的数字 ID 加密保存到 `records/forks/<PR>/<head>/<name>.json.age`。重复执行只接续同一审核申请和已记录的 ID。API 请求已经发出而返回 ID 尚未保存时，需要管理员核实该次创建结果并修复记录，避免接受同名的未登记仓库。

## 镜像初始化

镜像初始化的阶段加密保存到 `records/mirrors/<PR>/<head>/<name>.json.age`。`requested` 表示即将创建仓库；`created` 记录返回的仓库 ID；`copied` 表示已经关闭 GitHub Actions、推送预览中的分支和标签，并设置了默认分支。重新运行同一已批准提交的 Apply 时，程序从记录的阶段继续，再次推送相同提交不会改变目标仓库。

创建请求已经发出而 ID 尚未保存时，同名仓库没有对应记录，Apply 停止，需要管理员核实该仓库并修复记录。来源在预览之后改写或删除了预览中的提交时，Apply 在推送前停止，目标仓库保持为空并保留已记录的 ID，由管理员核实后处理。推送超过 GitHub 的 2 GB 上限时，Apply 报告推送错误。

Apply 完成后，程序核对目标仓库的分支和标签与预览快照一致，并确认 GitHub Actions 处于关闭状态。
