# 清理与兼容性说明

> 面向使用者和二次开发者：关闭侧聊到底删了什么、为什么没走 archive、会和哪些插件产生交集。
> 本文件是 v0.7.0 的实际行为说明；不是营销文案，删除路径都以代码为准。

## 一、关闭侧聊时删除什么

侧聊的删除由「浏览器半区关闭处理 + 宿主半区校验后删除」组成。宿主只接受本插件生成的 uuid，并校验 marker、journal 凭证或 session 的 scratch cwd；**不会按通配符删除其他会话**。

### 立即删除

| 产物 | 位置 |
|---|---|
| 侧聊目录（marker、context.md、scratch workspace 及其中文件） | `$DSH_HOME/quote-ask/<sideChatId>/` |
| 会话日志 | `$DSH_HOME/sessions/--<scratch-cwd projectKey>--/<sessionId>/`；bucket 为空时一并 rmdir |
| projection cache | `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` |
| spill 目录 | `%TEMP%/dsh-spill-*/session-<sha256(sessionId)[0:12]>/` |
| 浏览器会话映射 | `localStorage` 键 `dsh-quote-ask.sessions.v1` 中的该会话（为空时删除整个 key） |
| 浏览器重试队列 | `dsh-quote-ask.pending.v1` 中的该会话（为空时删除整个 key） |
| 浏览器草稿/视图缓存 | `dsh.conversation.<sideSessionId>` 及其子 key（关闭后 1.5s / 6s 再补删一次，处理 DSH 在 tab unmount 时的晚写） |
| 删除重试记录 | `dsh-quote-ask.graveyard.v1` 中的该 id；无重试项时删除整个 key |

### 延迟清理

宿主的 `cleanupSideChat` 使用两阶段 journal：关闭时先删产物、保留一条**只含 id/path/时间戳的清理凭证**，防止会话还活着时又晚写一次 projcache。正常关闭后：

- 第 5 秒：再删一次晚写的 projcache/spill；
- 第 20 秒：再删一次并移除 journal 凭证；
- 如果 DSH 在 20 秒内被强杀，下次启动的 sweep 会完成同样的收尾。

正常关闭并保持 DSH 运行 20 秒后，`quote-ask` 根目录只剩状态文件 `journal.json`，`pending` 为空对象。**聊天内容、日志、缓存、草稿、映射、凭证都不再存在。**

### 明确不删除

- 主对话的会话日志、projection cache、草稿、右侧栏主对话 tab；
- 其他会话、其他插件的数据；
- 你自己的主工作区文件；
- `$DSH_HOME/quote-ask/journal.json` 本身（插件状态文件；正常关闭后为空）。

### 极端情况

- DSH 崩溃或被强杀在关闭过程中：journal 凭证或客户端 pending 重试项会保留到下次启动/刷新，由 sweep 或客户端完成清理；期间不会有聊天内容残留。
- 清理无法证明会话归属（例如缓存和日志都已被外部删除）：宿主会保留 journal 并重试，而不是冒险删除；这是防止误删主对话/其他会话的安全边界。

### DSH 退出 / 重启

侧聊是 **session-scoped（当前 DSH 运行期有效）** 的：

- 完全退出/重启 DSH 时，Host 插件在销毁阶段同步删除所有仍 open 的侧聊；如果进程来不及，下一次启动的 sweep 会删掉上一次运行留下的所有 open 侧聊。
- 下一次启动的客户端会清除本地 quote-ask entry/pending/graveyard、对应 `dsh.conversation.<sessionId>` 草稿，并从保存的右侧栏布局里移除 `kind: quoteask` 的 tab；已经恢复出来的 tab 会通过 sidebar API 关闭。
- 因此重启后不会在「未分组」里留下侧聊会话，也不会出现打不开的侧聊标签页。
- `Ctrl+R` 页面刷新**不会**结束侧聊：Host 进程和侧聊会话仍然存活，插件用 sessionStorage 标记区分「应用启动」和「页面刷新」。
- 「添加至对话」的主对话附件保存在 `$DSH_HOME/quote-ask/main-quotes/<mainSessionId>.json`，只在主对话的下一轮 system prompt 中使用；一轮回答结束后由 Host 清空。完全退出/重启 DSH 会清空全部主对话附件，页面刷新保留（Host 进程未重启）。
- 主对话、其他插件的数据不受影响。

## 二、为什么不用 DSH 的 archive 隐藏侧聊

DSH 的 `archived-session-gate` 会对归档会话的每一个 `agent/pre-step` 返回 reject。实测表现是：

```
turn/start → turn/end { reason: { kind: "blocked" } }
```

模型永远不会被调用，侧聊无法回答。因此本插件**不归档侧聊**，而是在浏览器端按自己的 session id 注入精确的列表行隐藏规则：

```css
[data-row-key="session:<our-side-session-id>"] { display: none !important; }
```

这样既不会污染左侧列表，也不会触发模型的 archive gate。

## 三、和别的插件会不会冲突

### 占用的扩展点（均带命名空间）

| 类型 | 标识 |
|---|---|
| Host HTTP 路由 | `/dsh-quote-ask/*` |
| 右侧栏 tab | `id=dsh-quote-ask`，`kind=quoteask` |
| 资源协议 | `quoteask`（`dsh-resource://quoteask/session/<id>`） |
| 子 slot | `dsh-quote-ask.conversation` |
| 输入框工具位 | `conversation.input.left` 里的一个 chip（`dsh-quote-ask-quotes`） |
| 浮层 | `dsh-quote-ask.selection-menu` |
| system prompt | `quote-ask:context`（只对 scratch cwd 的侧聊会话生效） |
| localStorage | `dsh-quote-ask.*` |
| CSS | `.dsh-quote-ask-*` + 仅针对自己 session id 的行隐藏规则 |

### 现实中的交集

- **多个往输入框加控件的插件**：`conversation.input.left` 是列表 slot，各自注册，不互相覆盖。
- **另一个也接管「聊天区选中文本右键菜单」的插件**：可能出现两个菜单叠加；本插件只 `preventDefault`，不阻塞其他监听者。若遇到，二选一或给本插件提交 issue 增加开关。
- **另一个插件「归档全部会话」**：会把侧聊也归档，从而触发上面的 archive gate；这是 DSH 平台行为，不影响其他会话。
- **DSH 大版本升级**：`package.json` 的 `engines.dsh` 钉 `>=0.2.1-rc.2 <0.3.0`；0.3+ 会让插件拒绝加载（功能消失但不会拖垮 DSH），需要适配。

## 四、安全边界

- 删除函数按 uuid 白名单 + 路径包含关系 + marker/journal 所有权证明执行。
- 主对话文件不会被写入或删除；侧聊的「剔除引用」只作用于 `$DSH_HOME/quote-ask/<id>/context.md` 这个派生文件。
- 插件不发起网络请求；模型请求由 DSH 自身发出。
- 所有宿主代码在 `lib/index.js`，浏览器代码在 `lib/client/index.js`，可审计。
