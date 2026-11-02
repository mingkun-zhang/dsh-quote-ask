# 发布清单（把你的第一个开源项目发到 GitHub）

> 这份清单假设仓库已经在本机的 `work/dsh-quote-ask`（或你解压后的同结构目录）。
> 所有 `YOUR_GITHUB_USERNAME` 都可以用一处命令替换：
>
> ```powershell
> node scripts/set-repo-owner.mjs <你的GitHub用户名>
> ```
>
> 该脚本只改 `package.json` / `README.md` / `README.en.md`，不会联网、不会 push。

## 0. 账号与工具准备

本机当前检测到：

- Git 已安装（2.55），但 **全局 `user.name` / `user.email` 未配置**；
- 未安装 `gh`（GitHub CLI）、GitHub Desktop，也没有 `~/.ssh`；
- 凭据管理器里没有 GitHub 凭据。

因此建议走「浏览器 + Git 命令行（HTTPS + Git Credential Manager）」路线，不需要装新软件。

### 如果没有 GitHub 账号

1. 打开 <https://github.com/signup>，用常用邮箱注册；
2. 验证邮箱；
3. 在 **Settings → Password and authentication** 开启 2FA（GitHub 现在强烈建议/部分操作强制）；
4. 记下用户名——它会出现在仓库 URL、package.json 的 homepage/repository 里。

### 如果已有账号

在浏览器确认已登录，并准备在第一次 `git push` 时通过弹出的 Git Credential Manager 窗口授权。

## 1. 创建空仓库

GitHub 网页右上角 **+ → New repository**：

- Repository name: `dsh-quote-ask`
- Description: `Quote Ask (引问) for DeepSeek Harness Desktop: quote a main-conversation selection into the next prompt or a temporary side chat; side-chat artifacts are deleted when closed.`
- Public
- **不要**勾选 Add a README / Add .gitignore / Choose a license（仓库里已经有）
- Create repository

> 说明：`dsh-quote-ask` 是全新名字，当前 GitHub 上没有同名项目；旧的 `dsh-side-chat` 重名很多，所以这次改名也顺便避开了搜索拥挤。若以后想再改仓库名，可用脚本第二个参数更新 URL（package.json 里的包名不必跟着仓库名变）。

## 2. 配置 Git 身份（只需一次）

```powershell
git config --global user.name "你的名字或昵称"
git config --global user.email "你的GitHub邮箱"
```

> 邮箱会出现在 commit 记录里。若不想公开邮箱，可在 GitHub **Settings → Emails** 开启 “Keep my email addresses private”，并使用它提供的 `ID+username@users.noreply.github.com`。

## 3. 替换仓库所有者占位符

在仓库根目录（`package.json` 所在目录）执行：

```powershell
node scripts/set-repo-owner.mjs <你的GitHub用户名>
```

如果你的仓库不叫 `dsh-quote-ask`（例如想避开同名项目），传第二个参数：

```powershell
node scripts/set-repo-owner.mjs <你的GitHub用户名> <仓库名>
```

脚本只修改 GitHub URL；插件包名仍然是 `dsh-quote-ask`，不影响 DSH 安装。

## 4. 初始化并推送

```powershell
git init -b main
git add .
git status
git commit -m "feat: initial public release of dsh-quote-ask"
git remote add origin https://github.com/<你的用户名>/dsh-quote-ask.git
git push -u origin main
```

第一次 push 会弹出 Git Credential Manager 的 GitHub 登录窗口；登录并授权即可。如果推送失败：

- 仓库名/用户名拼写错误 → `git remote -v` 检查；
- 默认分支不是 main → `git branch -M main` 后再 push；
- 公司/校园网络拦截 HTTPS → 换网络或配置代理（不要提交代理密码到仓库）。

## 5. 仓库装修（GitHub 网页）

- **About**（右上齿轮）：
  - Description 同上；
  - Website 可留空或填 README；
  - Topics：`dsh`, `deepseek-harness`, `deepseek`, `plugin`, `quote-ask`, `electron`
- **Settings → General**：默认分支确认是 `main`；
- **Settings → Security**：开启 private vulnerability reporting（如果可用）；
- **Issues**：确保开启；
- 可选：Discussions、Wiki 暂不需要；
- 可选：Settings → Social preview 上传 `docs/assets/banner.svg`（GitHub 可能要求 PNG；可截图后上传）。

## 6. 发布第一个 Release

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
git tag -a v1.0.0 -m "dsh-quote-ask v1.0.0"
git push origin v1.0.0
```

在 GitHub 仓库页面 **Releases → Draft a new release**：

- Choose a tag: `v1.0.0`（已推送）
- Release title: `v1.0.0 — 首个公开版本`
- 描述：从 `CHANGELOG.md` 复制 1.0.0 段落；
- 上传 `dist/dsh-quote-ask-1.0.0.zip` 作为附件；
- Publish release。

> Release ZIP 的解压目录包含 `scripts/install-windows.ps1`，用户解压后可直接安装。
> GitHub 自动生成的 Source code (zip) 也可以安装，只是多包含 tests/CI 文件。

## 7. 发布后自查（用无痕窗口模拟新用户）

1. 退出 GitHub 登录或在无痕窗口打开仓库，确认 README 图片、链接、License 徽章都正常；
2. 点 **Code → Download ZIP**，解压到全新路径；
3. 按 README 运行 `install-windows.ps1`，完全退出并重启 DSH；
4. 选中文字右键测试一次；关闭侧聊；
5. 如果失败，按 README 的“已知限制/兼容性”核对 DSH 版本和桌面 profile。

## 8. 以后每次发版

1. 改 `package.json` 的 `version`（语义化版本）；
2. 在 `CHANGELOG.md` 顶部加一段；
3. 跑 `node scripts/check.mjs`；
4. commit，打 tag（`vX.Y.Z`），推送；
5. GitHub Release 上传新的 `dist/dsh-quote-ask-X.Y.Z.zip`。
