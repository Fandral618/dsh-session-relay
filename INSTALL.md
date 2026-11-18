# 安装与配置（另一台机器）

适用于已经装好 DeepSeek Harness 的机器。装完只需要三步收尾：**刷新 → 配对 → 验证**。

仓库是私有的，所以第二台机器上的 Git 方式安装需要 GitHub 凭据（`gh auth login`、SSH key
或系统凭据管理器三者之一）。拉不动就用方式 B（本地目录），完全不联网。

---

## 方式 A：贴 Git 地址（最快）

1. 侧边栏 **插件（Plugins）→ Add plugin**；下拉箭头里选 **Install a third-party plugin**；
2. 输入框贴：

   ```
   github:Fandral618/dsh-session-relay
   ```

   也可以贴完整地址 `https://github.com/Fandral618/dsh-session-relay`；
3. Install → 装完重启或刷新页面。

想锁死版本就 pin 一个完整 commit：

```
github:Fandral618/dsh-session-relay#<40 位 sha>
```

注意：Git 方式**装进来的是拷贝**，仓库以后再改不会自动生效；更新＝卸载重装。

## 方式 B：本地目录（离线最稳）

1. 在仓库页 **Code → Download ZIP**，解压到固定位置，例如 `D:\dsh-plugins\dsh-session-relay`；
2. **插件 → Add plugin** 里填这个**绝对路径** → Install。

目录方式装的是**引用**：解压位置要固定，装完不要移动或删除该目录。
这条路径完全没有网络请求，插件本身零依赖零构建，基本不会失败。

## 方式 C：让智能体装

在任意会话里说：

> 用 plugin_manager 的 install_bundle，target 用 `github:Fandral618/dsh-session-relay`

效果等同方式 A，只是会走一次审批。

**不要用 CLI**：`dsh plugin --profile web add …` 会装进 `profiles/web`，Desktop 应用
用的 profile 由应用托管，这样装的插件不会出现在 Desktop 里。

---

## 装完三步

### 1. 刷新

Host 半可能已通过 HMR 生效，但配置卡片是浏览器代码：刷新页面；工具行没出现就重启客户端。

### 2. 配对

1. 打开要当**开发**和**评审**的两个会话，各自调用 `session_whoami`，记下 `session-…`；
2. **插件 → 会话中继** 配置卡里新增一对：名称、项目、开发会话 ID、评审会话 ID、启用 → 保存。

`pairs` 默认是空数组，**必须自己配**：内置默认值只对本机作者有效，所以没有内置默认。

等价写法（profile 的 `cordis.patch.yml`，改完要重启）：

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

### 3. 验证

- 工具表里有 `session_send` 和 `session_whoami`；
- 插件列表里有一行「会话中继」，带图标和描述；
- 在两个会话里互发一条测试消息。首测建议 `delivery=queue`（两端会话都先打开），
  确认通了再用默认 `auto`。

---

## 故障对照

| 现象 | 原因与处理 |
| --- | --- |
| `Cannot access GitHub` / 连接超时 | GitHub 不可达。切 npmmirror 只加速 npm registry，**不代理 GitHub 仓库**——改用方式 B。 |
| 安装成功但插件列表看不到 | Desktop 的 profile 被应用托管。确认是在应用内的对话框装的，不是 CLI。 |
| 卡片/设置页不出现 | 浏览器还没刷新；或 `client.js` 的包名与 `package.json` 的 `name` 不一致。 |
| 工具报「不属于任何一对」 | 这个会话的 ID 没登记进 `pairs`，或登记的是别的机器上的旧 ID。重跑 `session_whoami`。 |
| `queue` 报错 | 对端会话没加载（冷会话）。先打开对端，或改用 `auto`。 |
| 自动投递报预算错误 | 触发了 `maxAutoWakePerHour`（默认 30/小时）。改用 `queue`，或等窗口重置。 |
| 装完两个会话互相唤醒不停 | 检查提示词约定：给出 `PASS` 后不要回复；必要时把 `autoWake` 设为 `false`。 |

---

## 更新与卸载

- 更新：**插件 → Remove** 后重新安装（Git 方式可选 pin 新 commit）。
- 卸载：插件列表里的 Remove。已配置的 `pairs` 随之消失，如需保留请先抄下来。
