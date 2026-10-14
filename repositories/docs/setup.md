# 管理员配置

仓库的 Check 工作流可以直接运行。Request 和 Apply 使用组织级 GitHub App、私有状态仓库和 GitHub Actions artifacts。完成本页配置后，设置 `AUTOMATION_ENABLED=true` 并运行 Apply，初始化加密状态和已应用提交记录。

## GitHub App

在 `gevico` 注册两个 GitHub App，关闭 Webhook，并安装到组织的全部仓库。

读取 App 的权限：仓库 `Administration: read`、`Contents: read`、`Metadata: read`，组织 `Members: read`。

写入 App 的权限：仓库 `Administration: write`、`Contents: write`、`Metadata: read`，组织 `Members: read`。工作流中的管理仓库检查、评论和重新运行操作使用 Actions 提供的 `GITHUB_TOKEN`。

保存以下配置：

- 仓库 variable `READ_APP_CLIENT_ID`：读取 App 的 Client ID。
- `preview` 环境 secret `READ_APP_PRIVATE_KEY`：读取 App 的完整 PEM 私钥。
- 仓库 variable `WRITE_APP_CLIENT_ID`：写入 App 的 Client ID。
- `production` 环境 secret `WRITE_APP_PRIVATE_KEY`：写入 App 的完整 PEM 私钥。

官方 `actions/create-github-app-token` 在每个任务中获取安装令牌。工作流明确设置 `owner: gevico`，覆盖该 App 安装范围内的仓库。

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

状态后端使用 [terraform-backend-git v0.1.12](https://github.com/plumber-cd/terraform-backend-git/tree/v0.1.12) 的 Git 存储、远程锁和 SOPS/age 加密。后端只在任务运行期间监听 runner 的 `127.0.0.1`，由 Terraform 的 HTTP 后端访问。任务结束后终止后端进程。构建和提交身份配置见 [后端说明](../../automation/backend/README.md)。

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
