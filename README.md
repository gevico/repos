<div align="center">

# gevico / repos

**用一句话申请仓库，通过一次 PR 完成审核。**

GitHub Actions 创建仓库、配置权限，并核验每次执行的结果。

[开始申请](#用日常语言申请) · [配置字段](automation/docs/requesting.md) · [管理员配置](automation/docs/setup.md) · [运行与恢复](automation/docs/operations.md)

</div>

---

## 用日常语言申请

克隆仓库，在支持仓库 skill 的编码助手中打开项目：

```bash
git clone https://github.com/gevico/repos.git
cd repos
npm --prefix automation ci
```

调用 `$repo-request`，直接描述你的需求：

> 在 gevico 下创建 qemu-plugins，用来研究 QEMU 插件。仓库设为公开，由 zevorn 管理。

仓库中的 [repo-request skill](.agents/skills/repo-request/SKILL.md) 会读取管理政策，生成 `repositories/qemu-plugins.yaml` 并运行校验。需要提交申请时，告诉助手“把这个申请提交为 PR”。

`repo-request` 使用当前编码助手理解自然语言。CI 根据审核后的 YAML 执行仓库管理。

## 从申请到创建

```mermaid
flowchart LR
    A[描述仓库需求] --> B[Skill 生成 YAML]
    B --> C[提交 PR]
    C --> D[Actions 校验和预览]
    D --> E[管理员审核合并]
    E --> F[Actions 创建和授权]
    F --> G[核验并报告结果]
```

每个仓库对应一份配置。权限调整也通过修改同一个文件并提交 PR 完成。

## 一份清晰的申请

```yaml
name: qemu-plugins
description: QEMU 插件研究与实验
visibility: public
topics:
  - qemu
access:
  users:
    zevorn: admin
  teams: {}
```

这是配置格式示例。实际申请中的名称、维护负责人和权限来自用户描述及组织政策。当前管理账号 `zevorn` 保留管理权限。

可用角色为 `pull`、`triage`、`push`、`maintain` 和 `admin`。团队使用现有组织团队的 slug。模板来源由管理员清单控制。[查看字段与权限说明](automation/docs/requesting.md)

## Actions 执行仓库管理

- **Check**：校验申请文件、运行程序测试，并检查 Terraform 配置。
- **Request**：读取 PR 中的 YAML 数据，检查真实 GitHub 身份、名称和模板，展示变更预览。
- **Apply**：合并后使用 Terraform 创建仓库、设置默认分支与权限、配置分支规则，并通过 GitHub API 核验。

工作流运行在 GitHub 托管 runner。GitHub App 提供组织访问权限，任务内生成临时令牌。Terraform 状态使用 SOPS/age 加密，保存在私有仓库 `gevico/repos-state`。PR 预览记录加密保存到 Actions artifacts；执行任务核验记录来源后，将记录保存到私有状态仓库。全部运行和存储使用 GitHub 资源。

管理员先完成 [部署配置](automation/docs/setup.md)。仓库申请开始执行的条件是 `AUTOMATION_ENABLED=true`，以及有效的 App 凭证、私有状态仓库和加密密钥。`gevico` 当前使用 GitHub Free；私有目标仓库需要先具备分支保护能力，再更新已核实的组织政策。

## 目录与文件

| 位置 | 内容 |
| --- | --- |
| [`automation/`](automation/) | 管理程序、Terraform、Schema、政策、测试与全部文档 |
| `repositories/` | 实际仓库申请的 `<name>.yaml` 文件 |
| `README.md` | 项目入口与申请流程 |

GitHub 从 `.github/` 发现工作流和审核配置，编码助手从 `.agents/skills/` 发现仓库 skill。这两个目录保留在项目根目录。

## 本地使用

生成并校验 YAML：

```bash
npm --prefix automation run request -- \
  --name qemu-plugins \
  --description "QEMU 插件研究与实验" \
  --maintainer zevorn
```

命令将 YAML 输出到终端。编码助手通过文件编辑工具保存申请。

```bash
npm --prefix automation run validate
npm --prefix automation run validate -- --online
npm --prefix automation run check
```

在线校验使用 `GH_TOKEN`、`GITHUB_TOKEN` 或本地 `gh` 登录。它查询用户、团队与模板。仓库创建由审核合并后的 Actions 执行。

## 文档与贡献

- [申请仓库和修改权限](automation/docs/requesting.md)
- [配置 GitHub App、状态仓库和加密密钥](automation/docs/setup.md)
- [执行结果、冲突、导入与恢复](automation/docs/operations.md)
- [已执行的验证](automation/docs/verification.md)
- [文档编写规范](automation/docs/documentation-guidelines.md)
- [贡献流程](.github/CONTRIBUTING.md)

申请文件、政策和工作流由 [CODEOWNERS](.github/CODEOWNERS) 指定的管理员审核。程序使用 [Terraform GitHub Provider](https://github.com/integrations/terraform-provider-github) 管理资源。[MIT License](LICENSE)
