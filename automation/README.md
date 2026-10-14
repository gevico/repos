# 仓库管理程序

此目录保存 `gevico/repos` 的实现与依赖。申请文件保存在项目根目录的 [`repositories/`](../repositories/)。

| 位置 | 职责 |
| --- | --- |
| `scripts/` | YAML 校验、GitHub 查询、预览、执行与结果核验 |
| `terraform/` | 仓库、默认分支、权限和分支规则 |
| `schema/` | 申请字段格式 |
| `policy.yml` | 组织、管理员、团队、模板和仓库政策 |
| `backend/` | Git 状态后端的编译配置和许可证 |
| `test/` | 配置、权限和工作流的程序测试 |
| `docs/` | 实施设计、调研证据和文档规范 |

在项目根目录运行：

```bash
npm --prefix automation ci
npm --prefix automation run check
npm --prefix automation run backend:build
```

中间文件、Terraform 工作目录和加密密钥备份保存在根目录的 `.work/`。GitHub Actions 与仓库 skill 分别位于 `.github/` 和 `.agents/`。
