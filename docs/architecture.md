# 架构说明

> 给想改代码的人。产品行为见 README；清理边界见 [cleanup-and-compatibility.md](./cleanup-and-compatibility.md)。

## 两个半区

DSH 插件可以同时注册宿主（Node）与浏览器（Web）代码：

| 文件 | 运行环境 | 职责 |
|---|---|---|
| `lib/index.js` | DSH 宿主 | 创建/删除 scratch 目录，注册 HTTP 路由，生成 `context.md`，注册 system-prompt section，启动清理 |
| `lib/client/index.js` | DSH 渲染进程 | 右侧栏 tab、空白会话渲染、引用 chip、选中文字右键菜单、关闭标签页 |

`cordis.patch.yml` 只插入一条 Host row，并把这个 row 限制在 `profileContext.name === 'desktop'` 时启用；Web profile 即使误装也不会挂载。

## 一次侧聊的生命周期

1. **选中文字 → 右键**
   客户端从选区读取 DOM 锚点：
   - `[data-chat-flow]` 消息行
   - `data-chat-node-key` / `data-chat-turn`
   - 用 `Range` 计算选中文字在该消息 `textContent` 中的字符偏移
   - 前后各 600 字、整条消息文本（上限 12k 字符）

2. **准备侧聊** `POST /dsh-quote-ask/prepare`
   宿主在 `$DSH_HOME/quote-ask/<id>/` 创建：
   - `workspace/`：侧聊会话的 scratch cwd
   - `marker.json`：主对话 id、quotes、anchor、状态
   - `context.md`：模型可见上下文
   如果 DSH 没提供 `systemPrompt` 服务，prepare 会拒绝打开，避免出现「看起来能用但模型没有上下文」的假成功。

3. **创建空白会话**
   客户端调用 `sessions.create({ cwd: scratchWorkspace })`，得到 session id；随后 `POST /bind` 写入 marker。
   这个会话**不 fork 主对话**，所以 UI 没有任何继承历史。

4. **模型上下文**
   宿主注册：

   ```js
   ctx.systemPrompt.section({
     name: 'quote-ask:context',
     order: 9500,
     interpolate: false,
     text: sideChatPromptContext,
   })
   ```

   `sideChatPromptContext` 只在 agent 的 session cwd 位于 `$DSH_HOME/quote-ask/<id>/workspace` 时读取 `context.md`；其他所有会话返回空字符串（被 DSH 渲染器丢弃），所以主对话的 prompt 完全不变。

5. **界面**
   右侧栏 tab 的 body 内再放一个 `SessionProvider`（侧聊 session），渲染共享的 `conversation.content` factory；因此输入框、流式回答、工具卡片都复用官方实现。

6. **引用增删**
   - `append-quote` / `remove-quote` 都由宿主重写 `context.md`；
   - 删除时把删除项写入 `marker.retiredQuotes`，生成转录时用 anchor 前后文匹配并替换成「〔该引用片段已删除〕」；
   - 重新添加同一引用会从 `retiredQuotes` 移除。

7. **关闭**
   浏览器先取消生成，等待 800ms 持久化，再 `POST /cleanup`；宿主删除产物并留下 journal 凭证；客户端删除 localStorage entry/draft，并在 1.5s/6s 后补删晚写草稿。

## 涉及到的 DSH 扩展点

- `sidebarRightTabs.register`：右侧栏 tab 类型
- `sidebar.right.pane.tab` slot：tab body
- `conversation.content` factory：对话渲染
- `conversation.input.left` slot：输入框工具栏里的引用 chip
- `shell.overlay` slot：右键菜单浮层
- `resources.register({ protocol: 'quoteask' })`：把 session 包装成 tab 可打开的资源
- `ctx.systemPrompt.section`：模型可见上下文
- `ctx.sessions.create` / `sessions.retain` / `sessions.using`：空白会话与关闭取消
- `workspaceRegistry`：仅用于兼容旧版 archive 记录的 unarchive（当前版本不归档）

## 为什么没有构建步骤

`lib/index.js` 是 ESM 宿主模块；`lib/client/index.js` 使用 DSH 的 `window.__ModuleLoader__.load({...})` 手写模块格式。两者都不需要 bundler，目录即产物——这是为了降低用户安装门槛，也让代码可以直接审计。

## 测试

`test/verify.mjs` 不依赖运行中的 DSH：它把 `DSH_HOME` 指向临时目录，mock 掉宿主 ctx、HTTP request/response、DSH client module loader 和 DOM，然后真实 import 两个半区并跑完整契约。适合在 CI 和提交前跑：

```bash
node test/verify.mjs
```
