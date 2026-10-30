# 管理员配置

仓库的 Check 工作流可以直接运行。Request 和 Apply 使用组织级 GitHub App、私有状态仓库和 GitHub Actions artifacts。完成本页配置后，设置 `AUTOMATION_ENABLED=true` 并运行 Apply，初始化加密状态和已应用提交记录。

## GitHub App

在 `gevico` 注册两个 GitHub App，关闭 Webhook，并安装到组织的全部仓库。

读取 App 的权限：仓库 `Administration: read`、`Contents: read`、`Metadata: read`，组织 `Members: read`。

写入 App 的权限：仓库 `Administration: write`、`Contents: write`、`Workflows: write`、`Metadata: read`，组织 `Members: read`。`Workflows: write` 只在执行镜像复制时申请，见[镜像复制](#镜像复制)。工作流中的管理仓库检查、评论和重新运行操作使用 Actions 提供的 `GITHUB_TOKEN`。

保存以下配置：

- 仓库 variable `READ_APP_CLIENT_ID`：读取 App 的 Client ID。
- `preview` 环境 secret `READ_APP_PRIVATE_KEY`：读取 App 的完整 PEM 私钥。
- 仓库 variable `WRITE_APP_CLIENT_ID`：写入 App 的 Client ID。
- `production` 环境 secret `WRITE_APP_PRIVATE_KEY`：写入 App 的完整 PEM 私钥。

程序使用官方 `@octokit/auth-app` 在任务中获取安装令牌，核实安装组织为 `gevico`、覆盖全部仓库且没有挂起。预览使用读取 App。执行先获得全安装范围的只读令牌检查身份；生命周期写入令牌按真实仓库 ID 限定范围，并包含私有状态仓库。任务结束后撤销临时令牌。

## 跨组织 Fork 和凭证检查

在 `production` 环境保存 `FORK_USER_TOKEN`，令牌属于组织所有者 `zevorn`，能够读取来源并在 `gevico` 创建 Fork。当前 `gh` 登录令牌可以通过以下命令保存，令牌内容经标准输入传递：

```bash
gh auth token --hostname github.com --user zevorn | gh secret set FORK_USER_TOKEN --repo gevico/repos --env production
gh variable set FORK_ENABLED --repo gevico/repos --body true
```

跨组织 Fork 由用户令牌执行。仓库管理、权限、归档和删除由 GitHub App 执行。GitHub 对 Fork App 的要求是同时安装到来源和目标账户；外部来源使用上述用户凭证。[GitHub Fork API](https://docs.github.com/en/rest/repos/forks#create-a-fork)

Credentials 工作流每天在 UTC 01:17 检查用户身份和组织所有者权限，也支持手动执行。令牌失效、缺失或权限不足时，自动在 `gevico/repos` 创建 Issue 并提及 `@zevorn`。已有同类未关闭 Issue 时复用；凭证恢复后关闭对应 Issue。Apply 的 Fork 凭证失败也使用该提醒。`FORK_ENABLED=true` 启用每日检查和跨组织 Fork 申请。

OAuth 令牌连续一年未使用会被 GitHub 撤销，用户、授权应用或 GitHub 也可以撤销令牌。更新上述 secret 后重新运行 Credentials 或失败的 Apply。[GitHub 令牌规则](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)

## 镜像复制

镜像复制由写入 App 推送来源的分支和标签。来源中的 `.github/workflows/` 文件要求推送令牌具有 `Workflows: write` 权限。为写入 App 增加该权限，在组织中批准新的权限请求，然后设置：

```bash
gh variable set MIRROR_ENABLED --repo gevico/repos --body true
```

`MIRROR_ENABLED=true` 时 Request 接收新的镜像申请。Apply 只在执行镜像申请时为写入令牌申请 `workflows` 权限，其他执行使用原有权限。允许的来源主机由 `automation/policy.yml` 的 `allowed_mirror_hosts` 维护，修改通过维护 PR 审核。

## 组织成员创建权限

组织普通成员创建公开、私有和内部仓库的权限全部关闭。`zevorn` 为组织所有者，保留手动创建权限；自动化使用已安装的 App 或经过配置的 Fork 用户身份。`bbbbbq` 为普通成员，在政策列出的四个仓库保留直接 `admin` 授权。

## 私有状态仓库和加密密钥

以组织所有者身份登录 `gh`，在克隆后的管理仓库运行：

```bash
npm --prefix automation ci
npm --prefix automation run state:setup
```

程序创建私有 `gevico/repos-state`，初始化 `main`，生成 age X25519 密钥并保存以下配置。状态仓库访问范围为组织所有者和具有相应权限的 App。

| 配置 | 位置 | 用途 |
| --- | --- | --- |
| `STATE_AGE_KEY` | `preview` 和 `production` 环境 Secrets | 解密状态及审核记录 |
| `STATE_AGE_RECIPIENT` | 管理仓库 variable | 加密时使用的 age 公钥 |
| `STATE_GIT_NAME` | 管理仓库 variable | 从本地 `git config user.name` 取得的提交姓名 |
| `STATE_GIT_EMAIL` | 管理仓库 variable | 从本地 `git config user.email` 取得的提交邮箱 |

密钥的本地备份为 `.work/state-age-key.txt`，文件权限为 `0600`。请将其保存到自己的密码管理器或安全备份位置。重复配置使用已有密钥；仓库已有公钥而本地密钥缺失时，程序要求恢复对应密钥。

状态后端使用 [terraform-backend-git v0.1.12](https://github.com/plumber-cd/terraform-backend-git/tree/v0.1.12) 的 Git 存储、远程锁和 SOPS/age 加密。后端只在任务运行期间监听 runner 的 `127.0.0.1`，由 Terraform 的 HTTP 后端访问。任务结束后终止后端进程。构建和提交身份配置见 [后端说明](../backend/README.md)。

私有状态仓库的文件：

- `gevico/repos/terraform.tfstate`：SOPS/age 加密的 Terraform 状态。
- `records/applied.json.age`：age 加密的已应用提交及核验结果。
- `records/reviews/<PR>/<head>.json.age`：age 加密的已批准申请预览。

后端通过远程 `locks/gevico/repos/terraform.tfstate` 分支锁定状态。每次状态和记录更新保留独立的 Git 提交，以及从实际 Git 配置读取的 `Signed-off-by`。

Request 使用只读 App 读取状态，将预览记录加密后上传为 Actions artifact。Apply 核验 artifact 所属的受信任工作流、基础代码提交、申请提交和运行次数，核对配置与依赖摘要，将批准记录保存到私有仓库，再执行已批准的操作。artifact 保留 90 天；合并前记录过期时需要重新执行预览。

两个 App 都需要安装到组织的全部仓库，确保可以访问 `repos-state` 和自动创建的目标仓库。

## 仓库审核规则

将审核负责人写入 `.github/CODEOWNERS`，并在 `automation/policy.yml` 指定目标仓库的管理员。当前配置使用组织管理员 `zevorn`，组织已有团队可加入允许清单。

实现推送到 `main` 后，以组织管理员登录的 `gh` 运行：

```bash
npm --prefix automation run bootstrap -- --check
npm --prefix automation run bootstrap -- --configure
```

配置包括 `main` 的必需审核、CODEOWNERS 审核、最新修改批准、严格更新要求，以及 `Validate` 和 `request/check` 必需检查。`preview` 和 `production` 环境限定部署分支为 `main`。审核者须能够独立审核申请人的 PR。

仓库申请 YAML 可以用可选的 `ruleset.admin_bypass` 调整默认分支规则。默认是 `none`；`pull_request` 允许仓库管理员在合并 PR 时绕过审核和检查，但直接推送仍受保护，默认分支的删除保护也保持不变；`always` 会同时允许直接推送，只应在明确需要时使用。

管理仓库允许普通合并（Create a merge commit），保留原始提交历史。压缩合并作为可选方法；申请人和审核者可以在 PR 中选择合并方法，程序支持这两种方法产生的合并提交。

## 初始化自动化

确认 App、环境 Secrets、状态仓库和 variables 均已保存，设置仓库 variable `AUTOMATION_ENABLED=true`。首次初始化时 `repositories/` 保持为空。手动运行 Apply 工作流，核验其初始化记录，然后接收目标仓库申请：

```bash
gh variable set AUTOMATION_ENABLED --repo gevico/repos --body true
gh workflow run apply.yml --repo gevico/repos --ref main
```

后续申请只需提交 PR。上一条已合并申请的 Apply 完成后，新的申请预览才可通过。

## 验证部署

用明确登记的真实仓库申请验证完整流程：通过 fork 或授权的申请身份创建 PR，管理员检查预览并审核，合并后确认目标仓库、默认分支、直接授权和分支规则。再通过配置 PR 验证权限修改与撤销，以及同一提交的重复执行。

私有仓库分支保护能力在 `automation/policy.yml` 中单独记录。管理员核实组织套餐和实际 API 能力后，才能设置 `private_branch_protection: true`。
