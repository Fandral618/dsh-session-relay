# dsh-session-relay

Pair two **independent** DeepSeek Harness Sessions — typically a developer and a
reviewer — and relay messages between them. Both Sessions stay ordinary root
Sessions: neither is a subagent of the other, neither inherits the other's
history, and either one can be opened, steered or stopped on its own.

[中文说明](#中文说明)

- **Multiple pairs.** Several projects, one pair each, in the same profile.
- **Three delivery modes.** Queue to the peer's next turn, wake an idle peer, or
  schedule a one-shot delivery.
- **A configuration card.** Pairs are edited in **Plugins → Session relay**, no
  YAML needed.

## What it does

A pair names two Session ids. When a Session in a pair calls `session_send`, the
message goes to the **other** side of that pair. Routing is by the caller's own
Session id, so a Session that belongs to more than one pair must name the pair.

`session_whoami` returns the current Session id and working directory — that is
how you register a Session into a pair.

## Install

Any of these, on a machine that already has DeepSeek Harness:

| Way | How |
| --- | --- |
| Git address | **Plugins → Add plugin** → `github:Fandral618/dsh-session-relay` (or the HTTPS URL) → Install |
| Local directory | Download the repository, then **Add plugin** → absolute path of the package folder |
| Agent | Ask the agent in a Session to run `plugin_manager` `install_bundle` with that spec |

On DeepSeek Harness Desktop, use the dialog: the Desktop profile is managed by
the app, and a CLI `dsh plugin --profile web add …` installs into `profiles/web`
and will not appear in Desktop.

After installing, refresh the page (the configuration card is browser code) and
restart if the tool rows are missing. Details and troubleshooting:
[INSTALL.md](INSTALL.md).

## Configure

1. Open the two Sessions that should be paired and run `session_whoami` in each.
2. **Plugins → Session relay** → add a pair: name, project, developer Session id,
   reviewer Session id, enabled.
3. Save. The value is written to the plugin's `pairs` config and applies
   immediately.

The `pairs` array ships **empty**: Session ids are unique to one installation, so
there is deliberately no default pair. The equivalent profile override:

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

## Tools

| Tool | Caller | Target |
| --- | --- | --- |
| `session_send({ to, text, pair?, delivery?, wake? })` | reviewer Session | `to: "developer"` — the pair's developer Session |
| | developer Session | `to: "reviewer"` — the pair's reviewer Session |
| `session_whoami()` | any paired Session | current Session id and working directory |

`pair` accepts a name, a project name, or a 1-based index, and is required only
when the calling Session belongs to several pairs.

### Delivery modes

| `delivery` | Behaviour |
| --- | --- |
| `auto` (default) | A running peer receives the message at its next step (the same queue-jump as the UI's “send now”); an idle peer is woken for a new turn; a cold peer is resumed. |
| `queue` | Appends to the peer's next-turn inbox without waking it. The peer must already be loaded as a live agent. |
| `schedule` | Creates a one-shot Schedule task, delivered on the peer's next turn with an auditable receipt. Visible in the automation tasks list. |

## Limits

- Per caller: `maxPerHour` messages per hour (default 100), body up to
  `maxTextLength` characters (default 50000).
- Wakes have their own budget, `maxAutoWakePerHour` (default 30), so two Sessions
  cannot wake each other in a loop. Past the budget the tool returns an error —
  use `delivery=queue` or wait for the window to reset.
- `delivery=queue` fails on a cold Session; `delivery=schedule` needs the
  Schedule service.
- The convention that stops the loop: after a `PASS` verdict, no reply is sent.

## Security

This plugin lets one Session hand text to another Session, and with
`delivery=auto` that text can start a turn in the peer. Treat a paired Session as
a channel into its peer: only pair Sessions you control, and do not pair a
Session with one that consumes untrusted input. Messages arrive on the peer side
as user messages, so the peer's agent will treat them as instructions.

The plugin opens no HTTP routes, makes no network requests, reads no files and
runs no shell commands. It registers two tools, a configuration card, and
metadata. `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools` and
`@deepseek-ai/schemastery` are provided by the running Host and are not declared
as installable dependencies.

## Update and remove

Installed from a Git address, the package is a copy: edits in the repository do
not reach an installed machine. Update by removing and reinstalling, optionally
pinning a commit (`github:Fandral618/dsh-session-relay#<40-char sha>`). Remove it
from **Plugins** (Remove) — the `pairs` you configured go away with it.

## Compatibility

Requires a DSH Host that provides `tools`, `agents`, `sessions`, `schedule`,
`sessionController` and `systemPrompt`, and the web client slots
`plugins.row.config` / `plugins.bundle.config` / `settings.plugins.tab`. Built and
verified against the DSH Desktop profile; no other host was tested.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

把两个**互相独立**的 DSH 会话（通常一个开发、一个评审）配成一对，在它们之间投递消息。两个会话都还是普通根会话，不互为子代理，也不继承对方历史。

**核心用法**

1. 打开要配对的两个会话，各自调用 `session_whoami` 拿到会话 ID；
2. **插件 → 会话中继** 里新增一对：名称、项目、开发会话 ID、评审会话 ID、启用；
3. 保存即生效。`pairs` 默认是空数组——会话 ID 只属于某一台机器，所以不内置任何默认配对。

**工具**

- `session_send({ to, text, pair?, delivery?, wake? })`：评审会话用 `to: "developer"`，开发会话用 `to: "reviewer"`；`pair` 在会话属于多对时才需要（名称、项目名或 1-based 序号）。
- `session_whoami()`：返回当前会话 ID 与工作目录，用于登记配对。

**投递方式**

| `delivery` | 行为 |
| --- | --- |
| `auto`（默认） | 运行中的对端在下一个 step 收到（等同 UI 的插队发送）；空闲对端被唤醒开新回合；冷会话被恢复。 |
| `queue` | 只写入对端下一回合收件箱，不唤醒；要求对端已加载。 |
| `schedule` | 走一次性 Schedule 任务，下一回合投递，有回执、可审计。 |

**限制**：每个调用方每小时 100 条、单条 50000 字符；自动唤醒另有每小时 30 条预算，防止两边互触发死循环；超出后工具报错，改用 `queue` 或等窗口重置。约定：给出 `PASS` 之后不再回复。

**安全**：这个插件能让一个会话把文本交给另一个会话，`auto` 模式下还会在对端开一个新回合。对端收到的是用户消息，其智能体会当成指令执行。只配对你自己控制的会话，不要把会话与消费不可信输入的会话配对。插件不开放 HTTP 路由、不联网、不读文件、不执行命令。
