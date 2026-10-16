# 发布到 npm 与 Pi 包目录

当前包名为 `pi-http`，准备的首个版本为 `0.1.0`，许可证为 MIT。项目已经配置发布元数据，但尚未执行 npm 发布。

Pi 包目录展示带 `pi-package` 关键词的 npm 包，发布后等待目录索引更新即可。包结构、关键词和宿主依赖规则见 [Pi 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)，发布操作见 [npm 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

## 已有发布配置

- `license: MIT`，仓库根目录包含完整 `LICENSE`。
- `repository`、`homepage`、`bugs` 指向本项目 GitHub 仓库。
- `keywords` 保留 `pi-package`，扩展入口为 `src/extension.ts`。
- `publishConfig` 指向公开 npm registry，并设置 `access: public`。
- `files` 限定源码、服务脚本、文档、示例配置和许可证；不分发 SDK、开发依赖、真实配置、环境文件、日志、数据库或聊天数据。
- Pi SDK 保留为宿主提供的 `peerDependency`，开发测试版本为 `1.3.0`。

`private: true` 已移除，使元数据具备发布条件；修改配置、运行测试、提交或推送 Git 都不会自动发布 npm。项目没有自动发布工作流，`release:check` 和 `prepublishOnly` 也不执行上传。

## 本地发布准备：不会上传

需要 Node.js 22.19 或更新版本。先安装开发依赖：

```bash
npm ci --include=dev --ignore-scripts
npm run release:check
```

`release:check` 依次执行类型检查、完整测试、`npm pack --dry-run`。测试包括真实 Pi 加载以及解压实际 tarball、仅安装声明的运行依赖后调用扩展；使用临时目录和本机模拟模型，需要能够绑定本机临时端口。

`npm pack --dry-run` 显示将要进入 tarball 的文件，不上传也不生成最终 tarball。需要本地交付物时运行：

```bash
npm pack --ignore-scripts
```

它会生成 `pi-http-0.1.0.tgz`；实际文件名随包名和版本变化。Pi 直接加载包中的 TypeScript 源码，因此打包不依赖 `dist/`，也不需要运行构建脚本。

## 确认发布账号和包名

在准备正式发布时，由发布者登录自己的 npm 账号并确认包名权限：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view pi-http name version --registry=https://registry.npmjs.org/
```

`npm view` 返回 `404` 只说明未找到对应公开包，并不预留包名；最终还要通过 npm 的命名和权限校验。如果包名被其他人占用，可使用自己的 npm 用户或组织作用域，例如 `@your-npm-user/pi-http`，将示例中的用户名替换为实际账号。

更换包名需要同步 `package.json`、`package-lock.json` 的根包信息，以及安装说明；也需要重新执行 `release:check`。不要直接使用 GitHub 用户名推定 npm 账号或作用域权限。

## 正式发布：单独执行

只有决定对外发布时才执行本节命令：

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

`prepublishOnly` 会先运行 `release:check`，失败时阻止本次发布。按 npm 提示完成登录或身份验证；不要用 `--ignore-scripts` 跳过发布前检查。

首次发布使用 `0.1.0`。后续按改动更新版本，已发布的包名与版本组合不能重复使用；更新版本后重新检查、提交代码，再发布。

## 发布后验证

```bash
npm view pi-http@0.1.0 version dist.tarball --registry=https://registry.npmjs.org/
pi install npm:pi-http@0.1.0
```

如果改用了作用域包名，替换以上命令中的 `pi-http`。在新的测试工作目录中启动 Pi，再执行 `/http init <可写的测试数据目录>`、`/http start`，验证模型列表和聊天接口。

最后到 [Pi 包目录](https://pi.dev/packages) 搜索完整包名。目录展示有索引延迟，GitHub 代码推送本身不等于 npm 发布或目录收录。
