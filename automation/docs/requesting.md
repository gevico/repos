# 仓库申请

在项目根目录使用 `$repo-request`，描述仓库名称、用途、可见性和维护负责人。助手根据 `automation/policy.yml` 生成配置，通过 `npm --prefix automation run validate` 核验后，保存到 `repositories/<name>.yaml`。

## 配置字段

- `name`：小写字母、数字和连字符组成的稳定名称，必须与文件名称一致。
- `description`：说明仓库保存的内容和用途。
- `visibility`：`public` 或 `private`；自然语言申请默认采用 `public`。私有仓库需要管理政策中已核实的分支保护能力。
- `topics`：可选的主题列表。
- `access.users`：GitHub 用户名与角色的映射。
- `access.teams`：GitHub 团队 slug 与角色的映射，团队须在政策的允许清单中。
- `template`：可选的 `owner` 和 `repository`，完整来源须在模板清单中。

角色含义：`pull` 读取内容，`triage` 管理议题与 PR，`push` 写入内容，`maintain` 维护仓库，`admin` 管理仓库设置与授权。

每份申请至少包含一个具有 `maintain` 或 `admin` 角色的个人或团队。政策中指定的管理员保持 `admin` 权限。

## 修改权限

修改现有文件中的 `access.users` 或 `access.teams` 并提交 PR。删除某个授权条目表示撤销该项直接授权。GitHub 组织角色、默认权限和团队继承仍影响用户的有效权限。

外部协作者可能收到需要本人接受的邀请。执行报告区分已生效授权与等待接受的邀请。

## 提交申请

申请 PR 只修改 `repositories/` 下的普通 YAML 文件。管理程序、政策和工作流使用独立的维护 PR。名称、初始化模板和申请文件身份在登记后保持稳定。

运行 `npm --prefix automation run validate`。本地 `gh` 已登录时，可运行 `npm --prefix automation run validate -- --online` 核验真实身份。然后提交 PR，检查 Actions 展示的变更预览。

管理员审核并合并后，Apply 工作流创建目标仓库并设置权限。成功结果包含仓库链接；失败结果包含对应工作流和恢复文档。

## 使用仓库 skill

技能文件位于 `.agents/skills/repo-request/SKILL.md`。支持 `.agents/skills` 自动发现的助手可在克隆后使用 `$repo-request`；其他支持 SKILL.md 的助手可以直接读取该文件并遵循其说明。依赖安装在项目根目录运行 `npm --prefix automation ci`。

需要提交 PR 时，明确要求助手提交。提交采用当前 Git 配置中的姓名和邮箱，通过 `git commit -s` 添加签名。
