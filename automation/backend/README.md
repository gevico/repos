# Git 状态后端

后端使用 [plumber-cd/terraform-backend-git v0.1.12](https://github.com/plumber-cd/terraform-backend-git/tree/v0.1.12)，许可证为 [Apache-2.0](LICENSE)。远程状态、Git 分支锁定和 SOPS/age 加密由该依赖提供。

`git.go` 对应此版本的 `storages/git/git.go`。后端读取完整 Git 历史，保留锁分支所需的父提交；提交函数从 `git config user.name` 和 `git config user.email` 读取身份，并追加唯一的 `Signed-off-by` 签名行。构建使用 Go 的 `-overlay` 参数，将该文件交给编译器。Go 模块和其依赖由 Go checksum database 核验，构建使用原有依赖锁定文件。

在项目根目录运行：

```bash
npm --prefix automation run backend:build
```

需要 Go 1.24 或更新版本。程序、模块缓存和构建中间文件保存在 `.work/`。运行时后端仅监听 runner 的 `127.0.0.1`，任务结束后终止。
