# 安装与故障排查

主 README 有最短路径；这里放更完整的安装说明和排错。

## 前置检查

- **DeepSeek Harness Desktop**（不是浏览器里的 Web 版）已安装并能正常打开；
- DSH 版本为 `0.2.1-rc.2` 或同系列 `0.2.x`（`0.3+` 会被插件的 `engines` 拒绝加载）；
- 知道 DSH 的安装目录（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`）；
- 插件文件夹中有 `package.json`、`cordis.patch.yml`、`lib/`、`locale/`、`icon.svg`。

## 安装方式 A：一键脚本（Windows）

从仓库根目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

- 脚本会查找 DSH 安装目录，并执行 `dsh plugin --profile desktop add <仓库路径>`；
- 先看命令不动手：加 `-DryRun`；
- DSH 不在默认路径：加 `-DshRoot "D:\path\to\DeepSeek Harness"`。

## 安装方式 B：手动命令行

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "<仓库绝对路径>"
```

路径有空格/中文时务必保留双引号。安装完成后：

**完全退出 DSH Desktop（包括托盘进程）→ 重新启动。**

`Ctrl+R` 只会刷新页面，不会重新加载宿主插件和客户端模块。

## 安装方式 C：Release ZIP

从 GitHub Releases 下载 `dsh-quote-ask-<version>.zip`，解压到稳定目录（不要放在临时目录；DSH profile 会链接到这里），然后按方式 A/B 安装解压目录。

## 验证是否加载

- 打开任意对话，选中聊天内容中的文字；
- 右键应出现「在侧边聊天中提问」；
- 右侧栏出现「侧聊 · …」标签页；
- 在侧聊提问，回答应能结合主对话与引用。

如果右键菜单没出现：确认选中的是**对话消息正文**，不是输入框；确认不是 Web 版。

## 常见问题

### 安装命令报 "managed exclusively by the Electron application"

说明你跑的是独立 dsh CLI，而不是 DSH Desktop 自带的 CLI。使用：

```text
<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd
```

### 下载的 ZIP 解压后 PowerShell 脚本被拦

Windows 可能给从浏览器下载的 ZIP 打上 Mark-of-the-Web。先对 ZIP 右键 → 属性 →
勾选「解除锁定（Unblock）」再解压；或者对解压后的 `.ps1` 文件执行：
`Unblock-File .\scripts\install-windows.ps1`。本仓库脚本没有签名，用
`-ExecutionPolicy Bypass` 只对当前进程生效，不修改系统策略。

### 插件页显示安装成功，但重启后没效果

- 是否**完全退出**了 DSH（任务管理器里没有残留）？
- 是否装到了 `desktop` profile（命令里必须有 `--profile desktop`）？
- DSH 版本是否在 `>=0.2.1-rc.2 <0.3.0`？

### 右键没有菜单 / 引用 chip 不出现

- 只在主对话消息区域选中文字时出现；
- 侧聊标签页必须处于打开状态；
- 若安装了其他「选中文字右键菜单」插件，可能被占用，先停用其他插件再试。

### 侧聊回答没有用到引用或主对话

- 旧会话/旧版本可能存在上下文为空的问题，升级到 0.5.3 后重启；
- 引用删除后要等下一轮提问才生效（当前正在生成的回答仍使用旧请求）；
- 主对话非常长时只保留最近 60 万字符。

### 关闭侧聊后还能找到痕迹吗

正常关闭并保持 DSH 运行约 20 秒后，内容、日志、缓存、草稿和清理凭证都会删除；强杀 DSH 时由下次启动清理。详见 [cleanup-and-compatibility.md](./cleanup-and-compatibility.md)。

### macOS / Linux

本版本只在 Windows 11 上完整验证。其他平台请找到 DSH 安装目录下等价的
`resources/runtime/cli/bin/dsh`，使用同样的 `plugin --profile desktop add` 命令；
欢迎在 GitHub Issues 反馈结果。
