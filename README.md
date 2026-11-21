# dsh-session-relay（会话中继）

把两个**互相独立**的 DeepSeek Harness 会话——通常一个开发、一个评审——配成一对，在它们之间投递消息。两个会话都还是普通根会话：不互为子代理，不继承对方历史，任何一个都能单独打开、引导或停止。

- **多对并存**：同一个 profile 里可以有多个项目，每个项目一对。
- **三种投递方式**：排队到对端下一回合、唤醒空闲对端、安排一次性投递。
- **配置卡片**：配对在 **插件 → 会话中继** 里编辑，不用写 YAML。

## 它做什么

一对由两个会话 ID 组成。配对中的某个会话调用 `session_send` 时，消息投给这一对的**另一侧**。路由依据调用方自己的会话 ID，所以同时属于多对的会话必须指明 `pair`。

`session_whoami` 返回当前会话 ID 与工作目录——登记配对时用它。

## 安装

机器上已经装好 DeepSeek Harness 后，下面三种任选一种：

| 方式 | 做法 |
| --- | --- |
| Git 地址 | **插件 → Add plugin** → `github:Fandral618/dsh-session-relay`（或完整 HTTPS 地址）→ Install |
| 本地目录 | 下载仓库，然后 **Add plugin** → 填插件目录的绝对路径 |
| 让智能体装 | 在会话里让智能体用 `plugin_manager` 的 `install_bundle`，target 填上面的 spec |

仓库是公开的，Git 方式安装不需要 GitHub 凭据。

桌面版（DeepSeek Harness Desktop）请用应用内的对话框：Desktop 的 profile 由应用托管，用 CLI `dsh plugin --profile web add …` 会装进 `profiles/web`，在 Desktop 里看不到。

装完刷新页面（配置卡片是浏览器代码）；工具行没出现就重启客户端。细节与故障排查见 [INSTALL.md](INSTALL.md)。

## 配置

1. 打开要配对的两个会话，各自调用 `session_whoami`。
2. **插件 → 会话中继** → 新增一对：名称、项目、开发会话 ID、评审会话 ID、启用。
3. 保存。值写入插件的 `pairs` 配置，立即生效。

`pairs` 默认是**空数组**：会话 ID 只属于某一台机器，所以刻意不内置任何默认配对。等价的 profile 覆盖写法：

```yaml
- id: session-relay
  name: dsh-session-relay
  config:
    pairs:
      - name: my-project
        project: my-project
        developerSessionId: 'session-…'
        reviewerSessionId: 'session-…'
        enabled: true
```

## 工具

| 工具 | 调用方 | 目标 |
| --- | --- | --- |
| `session_send({ to, text, pair?, delivery?, wake? })` | 评审会话 | `to: "developer"` —— 这一对的开发会话 |
| | 开发会话 | `to: "reviewer"` —— 这一对的评审会话 |
| `session_whoami()` | 任意已配对会话 | 当前会话 ID 与工作目录 |

`pair` 接受名称、项目名或 1-based 序号，只有当前会话属于多对时才需要。

### 投递方式

| `delivery` | 行为 |
| --- | --- |
| `auto`（默认） | 运行中的对端在下一个 step 收到（等同 UI 的插队发送）；空闲对端被唤醒开新回合；冷会话被恢复。 |
| `queue` | 只写入对端下一回合收件箱，不唤醒。要求对端已加载为活会话。 |
| `schedule` | 创建一次性 Schedule 任务，在对端下一回合投递，有回执、可审计，可在自动化任务列表里看到。 |

## 限制

- 每个调用方：每小时 `maxPerHour` 条（默认 100），单条最长 `maxTextLength` 字符（默认 50000）。
- 唤醒有独立预算 `maxAutoWakePerHour`（默认 30），避免两个会话互相唤醒成死循环。超出后工具直接报错——改用 `delivery=queue` 或等窗口重置。
- `delivery=queue` 对冷会话会失败；`delivery=schedule` 需要 Schedule 服务。
- 阻止循环的约定：给出 `PASS` 结论后不再回复。

## 安全

这个插件让一个会话把文本交给另一个会话，`delivery=auto` 下这段文本还能在对端开一个新回合。把已配对的会话当成通往对端的通道：只配对你自己控制的会话，不要把会话与消费不可信输入的会话配对。消息到达对端时是用户消息，对端智能体会把它当指令执行。

插件不开放 HTTP 路由、不发起网络请求、不读文件、不执行 shell 命令。它只注册两个工具、一个配置卡片和元数据。`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 由运行中的 Host 提供，不作为可安装依赖声明。

## 更新与卸载

从 Git 地址安装的是**拷贝**：仓库后续改动不会自动到达已安装的机器。更新＝卸载重装，可选 pin 某个 commit（`github:Fandral618/dsh-session-relay#<40 位 sha>`）。卸载在**插件**里点 Remove——已配置的 `pairs` 会随之消失。

## 兼容性

需要提供 `tools`、`agents`、`sessions`、`schedule`、`sessionController`、`systemPrompt` 的 DSH Host，以及 web 客户端插槽 `plugins.row.config` / `plugins.bundle.config` / `settings.plugins.tab`。已在 DSH 桌面版 profile 上构建并验证；未测试其他 host。

## 许可证

MIT，见 [LICENSE](LICENSE)。
