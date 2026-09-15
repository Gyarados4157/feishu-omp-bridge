# feishu-omp-bridge

[English documentation](README.md)

`feishu-omp-bridge` 把飞书 / Lark 消息桥接到本机的 [Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi) Agent。它接收私聊、群聊中 `@bot` 的消息、话题消息和云文档评论中的提及，把内容发送给 `omp --mode rpc`，再将结果以卡片或 Markdown 流式回复到飞书。

> **安全提醒：** OMP 可以读写文件、执行本机命令。也就是说，发送到飞书的消息可能触发运行 bridge 的机器上的操作。将 bot 加入群聊前，请先配置访问控制和 OMP 工具白名单。

## 能力概览

- 按 chat / topic 隔离 OMP session、工作目录、消息队列和运行中的任务。
- 流式展示助手文本、思考过程、工具调用、工具增量、token 用量和错误。
- 将 OMP 原生 `confirm`、`select`、`input`、`editor` 请求映射为飞书交互卡片。
- 展示 OMP extension 的 `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` 和 `open_url` 事件。
- 为每个 OMP run 注册飞书 host tools：
  - `feishu_current_context`
  - `feishu_send_message`
  - `feishu_reply_message`
  - `feishu_get_message`
- 注册只读 OMP URI：
  - `feishu://current/context`
  - `feishu://message/<message_id>`
- 图片和文件会下载到本地缓存；图片会作为 OMP RPC image content 发送。
- 运行中的 chat / topic 收到新消息时，普通消息作为 `steer` 进入当前 run（中断路径）；`/queue <消息>` 作为 `follow_up` 排队，当前请求完整跑完后由新卡片回答。OMP 内置命令（如 `/usage`、`/stats`）由 OMP 直接执行，不再作为普通文本交给模型。
- 消息前加 `!`（如 `!别管这个了，先看下一个问题`）会强制打断：停止当前 run、旧卡片标记为已中断、丢弃积压队列中的旧消息，然后该消息作为全新 turn 在新 run 中处理（session 会 resume，上下文保留）。比 steer 更强——steer 只能在同一个 run 内部打断进行中的回合。
- 同时支持前台运行和操作系统管理的后台 daemon。

## 前置条件

- Node.js `>=20`
- pnpm
- 已安装并完成模型 / provider 配置的 Oh My Pi
- 一个飞书或 Lark PersonalAgent 应用

请按照 OMP 官方文档安装和配置 OMP。例如 macOS / Linux 可以使用：

```bash
curl -fsSL https://omp.sh/install | sh
omp --version
```

请用将要运行 bridge 的同一个操作系统用户先运行一次 OMP，完成模型和认证配置，然后确认 RPC 命令可用：

```bash
omp --mode rpc
```

该命令应打印 JSON `ready` 帧并等待输入；完成 smoke test 后按 `Ctrl-C` 退出。如果 OMP 是通过 Bun、nvm、Homebrew 或其他用户级工具链安装的，请在使用 `start` 前阅读[后台 daemon 的 PATH 和凭据](#后台-daemon-的-path-和凭据)。

## 从源码安装和构建

```bash
git clone https://github.com/Gyarados4157/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
```

仓库入口是 `bin/feishu-omp-bridge.mjs`。构建后可以这样运行：

```bash
node bin/feishu-omp-bridge.mjs <命令>
```

如果项目已经作为包安装或 link 到全局，也可以使用：

```bash
feishu-omp-bridge <命令>
```

## 首次启动

前台启动 bridge：

```bash
node bin/feishu-omp-bridge.mjs run
```

如果默认配置不存在或不完整，bridge 会进入二维码向导。用飞书 App 扫码创建 / 注册 PersonalAgent 应用。向导会把配置写入 `~/.feishu-omp-bridge/`；如果能取得扫码用户的身份，还会自动把该用户设为初始管理员。

`run` 是前台进程，需要保持终端打开；按 `Ctrl-C` 可停止。省略子命令时，CLI 默认执行 `run`：

```bash
node bin/feishu-omp-bridge.mjs
```

常用选项：

```bash
# 跳过可选的 lark-cli 安装 / bind 检查
node bin/feishu-omp-bridge.mjs run --skip-check-lark-cli

# 为前台进程指定配置文件
node bin/feishu-omp-bridge.mjs run --config /path/to/config.json
```

`start` 不会进入二维码向导，也不接受 `--config`。需要使用自定义配置文件时，请先用 `run --config ...` 完成配置；后台 daemon 使用默认的 `~/.feishu-omp-bridge/config.json`。

## 前台 `run` 和后台 `start`

两者是有意区分的命令：

| 命令 | 含义 |
| --- | --- |
| `run` | 在当前终端运行一个 bridge 进程。 |
| `start` | 安装 / 重写并启动操作系统管理的后台 daemon。 |
| `stop` | 停止 daemon，并关闭自动启动；保留注册文件。 |
| `restart` | 重启已注册的 daemon，不删除注册。 |
| `status` | 查看 daemon 状态、PID 和日志路径。 |
| `unregister` | 停止 daemon 并删除操作系统服务注册；bridge 数据保留。 |
| `ps` | 列出本机的 bridge 进程，包括前台进程。 |
| `kill <id\|序号>` | 向 `ps` 列出的指定进程发送终止信号；序号从 1 开始。 |

后台 daemon 不是另一套 bot 实现。`start` 生成的操作系统服务实际执行的命令等价于：

```text
node <bridge-entry-point> run
```

因此，修改源码或重新构建后，应再次执行 `start`，让服务定义捕获当前的 Node 可执行文件、入口路径和 PATH。

### 启动和管理 daemon

```bash
node bin/feishu-omp-bridge.mjs start
node bin/feishu-omp-bridge.mjs status
node bin/feishu-omp-bridge.mjs restart
node bin/feishu-omp-bridge.mjs stop
node bin/feishu-omp-bridge.mjs unregister
```

`start` 会在安装服务前执行可选的交互式 `lark-cli` 预检查。跳过检查：

```bash
node bin/feishu-omp-bridge.mjs start --skip-check-lark-cli
```

支持的平台和服务管理器：

| 平台 | 服务管理器 | 注册名称 |
| --- | --- | --- |
| macOS | launchd 用户 Agent | `ai.feishu-omp-bridge.bot` |
| Linux | systemd 用户 unit | `feishu-omp-bridge.bot.service` |
| Windows | Windows Task Scheduler | `FeishuOmpBridge.Bot` |

Linux 用户服务如果需要在退出登录后继续运行，可能还需要启用 user lingering：

```bash
loginctl enable-linger "$USER"
```

### Secret keystore 命令

二维码向导通常会自动管理加密的 App Secret。需要维护时可以使用：

```bash
feishu-omp-bridge secrets list
feishu-omp-bridge secrets set --app-id cli_xxx
feishu-omp-bridge secrets remove --app-id cli_xxx
```

`secrets get` 是给 `lark-cli` 使用的内部 JSON-over-stdin provider，不是用来直接打印 secret 的命令。

## 后台 daemon 的 PATH 和凭据

服务管理器不一定会加载 `.zshrc`、`.bashrc` 或其他 shell profile。因此，每次 `start` 安装 / 重写服务时，bridge 会捕获当前进程的 `PATH`。请在能正常运行 OMP 的同一个用户 shell 中执行：

```bash
command -v node
command -v omp
omp --version
```

注意：

1. 不要使用 `sudo start`。这是用户级服务，OMP 的认证和 session 文件也属于该用户。
2. 如果服务找不到 `omp`，可以在 `preferences.ompBinary` 中写绝对路径，例如 `/Users/me/.bun/bin/omp` 或 `/home/me/.local/bin/omp`。
3. 如果 `omp` 脚本使用 `#!/usr/bin/env bun`，Bun 所在目录也必须在服务的 PATH 中；只有脚本绝对路径可能仍然不够。
4. 更换 Node、Bun、OMP 或 PATH 后，重新执行 `start`，刷新生成的服务文件。
5. daemon 捕获的是 `PATH`，不会自动复制交互式 shell 中任意导出的 API key。优先使用 OMP 为该操作系统用户保存的登录 / 配置；如果 provider 依赖环境变量，请把变量配置到服务管理器可见的环境中，不要假定 shell profile 会被加载。

前台 `run` 正常而 `start` 不正常时，可检查生成的服务和日志：

- macOS plist：`~/Library/LaunchAgents/ai.feishu-omp-bridge.bot.plist`
- Linux unit：`${XDG_CONFIG_HOME:-~/.config}/systemd/user/feishu-omp-bridge.bot.service`
- Windows launcher：`~/.feishu-omp-bridge/daemon-launcher.cmd`

## 配置文件

默认配置路径：

```text
~/.feishu-omp-bridge/config.json
```

二维码向导会写入 app 配置，并通常把 App Secret 移入本地加密 keystore。生成的配置大致如下（`command` 实际会被写成绝对路径）：

```json
{
  "accounts": {
    "app": {
      "id": "cli_xxxxxxxxxxxxxxxx",
      "tenant": "feishu",
      "secret": {
        "source": "exec",
        "provider": "bridge",
        "id": "app-cli_xxxxxxxxxxxxxxxx"
      }
    }
  },
  "secrets": {
    "providers": {
      "bridge": {
        "source": "exec",
        "command": "~/.feishu-omp-bridge/secrets-getter",
        "args": []
      }
    }
  },
  "preferences": {
    "ompBinary": "omp",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions",
    "messageReply": "markdown",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "requireMentionInGroup": true
  }
}
```

### `preferences` 字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `ompBinary` | `omp` | OMP 可执行文件名或绝对路径。 |
| `ompModel` | OMP 自身默认值 | 传给 `omp --model` 的模型。 |
| `ompThinking` | OMP 自身默认值 | 传给 `omp --thinking` 的思考级别。 |
| `ompSessionDir` | `~/.feishu-omp-bridge/omp-sessions` | bridge 专用 OMP session 目录。 |
| `ompTools` | OMP 自身默认值 | 传给 `omp --tools` 的逗号分隔工具白名单。 |
| `messageReply` | `markdown` | `card`、流式 `markdown` 或一次性 `text`；`card` 的交互能力最完整。 |
| `showToolCalls` | `true` | 是否在回复中展示工具调用过程。 |
| `maxConcurrentRuns` | `10` | 全局并发 run 上限，代码会限制在 `1..50`。 |
| `runIdleTimeoutMinutes` | 关闭 | 多久没有 RPC 事件后终止 run；范围 `1..120` 分钟，`0` 关闭。 |
| `requireMentionInGroup` | `true` | 普通群和话题群是否必须 `@bot`；私聊不受影响。 |
| `agentStopGraceMs` | `5000` | OMP 收到 SIGTERM 后等待 SIGKILL 的毫秒数，范围 `100..30000`。 |
| `access` | 不限制 | 用户 / 群白名单和管理员设置，见下文。 |

`messageReply: "text"` 表示 run 完成后只发送一条 Markdown 消息，并不是完全不带格式的纯文本。旧配置中的 `codexBinary` 和 `codexModel` 仍会在对应 OMP 字段缺失时作为 fallback 读取。

### 访问控制

```json
{
  "preferences": {
    "access": {
      "allowedUsers": ["ou_xxx"],
      "allowedChats": ["oc_xxx"],
      "admins": ["ou_xxx"]
    }
  }
}
```

- `allowedUsers` 为空或未设置：允许所有用户。
- `allowedChats` 为空或未设置：允许所有群聊。
- `admins` 为空或未设置：所有允许的用户都拥有管理员权限。
- 管理员命令包括 `/account`、`/config`、`/exit`、`/reconnect`、`/doctor`、`/cd` 和 `/ws`。

## 飞书聊天命令

| 命令 | 作用 |
| --- | --- |
| `/new`、`/reset` | 清空当前 chat / topic 的 OMP session。 |
| `/new chat [name]` | 创建新群并邀请发送者；需要 `im:chat` 权限。 |
| `/cd <绝对路径\|~/路径>` | 切换当前工作目录并重置 session。 |
| `/ws list` | 列出命名工作空间。 |
| `/ws save <name>` | 将当前工作目录保存为命名工作空间。 |
| `/ws use <name>` | 切换命名工作空间并重置 session。 |
| `/ws remove <name>` | 删除命名工作空间。 |
| `/config` | 打开偏好设置卡片。 |
| `/account` | 更换 bot app 凭据并重连。 |
| `/status` | 查看 scope、工作目录、session 和 agent 信息。 |
| `/stop` | 停止当前 chat / topic 的 OMP run。 |
| `/queue <消息>` | 把消息作为 follow-up 排入当前 run：当前请求跑完后由新卡片回答。 |
| `/timeout [N\|off\|default]` | 设置、关闭或恢复当前 session 的 idle timeout；`N` 为 `1..120` 分钟。 |
| `/ps` | 列出本机 bridge 进程。 |
| `/exit <id\|序号>` | 关闭指定 bridge 进程；序号对应 `/ps` 中从 1 开始的行号。 |
| `/reconnect` | 重连飞书 WebSocket。 |
| `/doctor [描述]` | 让 OMP 检查最近的脱敏日志和故障描述。 |
| `/help` | 显示帮助卡片。 |

群聊消息默认需要 `@bot`；私聊不需要。`@全员` 不会被当作对 bot 的提及。

## OMP RPC 生命周期

bridge 消费 OMP 的 JSONL RPC 流。`prompt` 的成功 response 通常只表示命令已被接受，不表示 Agent 已经完成。Agent turn 会在 terminal `agent_end` 事件到达后结束：

- `isTerminal: false` 表示中间 settle，OMP 可能还会发送更多事件（例如异步 continuation）。
- `isTerminal: true` 表示 run 已完成。
- 旧版 OMP 可能不发送 `isTerminal`；缺少该字段时，为了兼容旧协议会按终止事件处理。
- OMP 处理但不启动 Agent 的本地命令（例如 OMP 自己处理的 slash command）会通过 prompt response 中的 `data.agentInvoked: false` 或 `prompt_result` 帧完成。

这个区别可以避免新版 OMP 在中间事件后被 bridge 提前截断；此前提前结束可能使飞书最终回复变成 `(no content)`。如果 OMP 在接受 prompt 后干净退出、却没有发送 terminal `agent_end`，adapter 现在会报告错误，而不会静默生成空成功卡片。

从源码升级 bridge 后，请重新构建并刷新 daemon：

```bash
pnpm build
node bin/feishu-omp-bridge.mjs start
```

## 日志和数据目录

默认情况下，bridge 的状态都保存在 `~/.feishu-omp-bridge/`：

| 路径 | 用途 |
| --- | --- |
| `config.json` | App 配置、SecretRef 和偏好设置。 |
| `secrets.enc` | 本地加密 App Secret keystore。 |
| `.keystore.salt` | keystore salt。 |
| `secrets-getter` | 读取 keystore 的私有 exec-provider wrapper。 |
| `sessions.json` | OMP session ID、工作目录和每个 session 的 timeout 覆盖。 |
| `omp-sessions/` | bridge 专用 OMP JSONL session 文件。 |
| `workspaces.json` | 命名工作空间映射。 |
| `processes.json` | 本机 bridge 进程注册表。 |
| `media/` | 下载的飞书图片 / 文件缓存。 |
| `logs/` | 结构化日志以及 daemon stdout / stderr 日志。 |

查看 daemon 输出：

```bash
tail -f ~/.feishu-omp-bridge/logs/daemon-stdout.log
tail -f ~/.feishu-omp-bridge/logs/daemon-stderr.log
```

## 故障排查

### 找不到 `omp`

用运行 daemon 的同一个用户执行 `omp --version`。必要时在 `preferences.ompBinary` 中设置绝对路径，同时把 OMP 所需的运行时（例如 Bun）放进 daemon 的 PATH；然后重新执行 `start`。

### 前台 `run` 正常，但后台 `start` 不正常

检查生成的服务文件和 daemon 日志。`start` 只会在安装服务时捕获 PATH，不会自动加载 shell profile，也不会复制交互式 shell 中任意导出的 API key。用服务用户完成 OMP 登录 / 配置；修改环境后重新安装或执行 `start` 刷新服务。

### 最终回复显示 `(no content)`

先构建当前 bridge，并重启 daemon，让新的 RPC adapter 生效：

```bash
pnpm build
node bin/feishu-omp-bridge.mjs restart
```

如果服务还没有注册，则使用 `start`。随后检查两个 daemon 日志。provider 的 terminal 错误现在会显示为 Agent 失败；缺少 terminal `agent_end` 则会显示 adapter 错误，而不是伪装成成功但为空的 run。

### OMP 启动了但没有回答

以相同用户单独运行 OMP，确认模型 / provider 配置有效。检查 `daemon-stderr.log` 和结构化日志中的认证、配额、网络及 provider 错误。若 OMP 无法认证或访问 provider，bridge 无法生成回答。

### 群聊没有响应

先 `@bot`，或将 `preferences.requireMentionInGroup` 设置为 `false`。同时检查 `allowedUsers` 和 `allowedChats`。

### run 卡住

发送 `/stop` 终止当前任务。也可以对当前 session 发送 `/timeout 10`，或在全局配置 `runIdleTimeoutMinutes`。当 OMP 正在等待工具或原生 UI 响应时，idle watchdog 会暂停。

### OMP 请求确认或输入

完成飞书中单独出现的 OMP 交互卡片。等待该请求期间，idle watchdog 会暂停。

### 飞书 API 工具不可用

bridge 自带的 Feishu host tools 不依赖 `lark-cli`。如果还需要让 OMP 使用传统 CLI 工具，可以在启动提示中安装和 bind，或手动执行：

```bash
npm install -g @larksuite/cli
lark-cli config bind --source lark-channel --identity bot-only
```

### `/new chat` 失败

确认 PersonalAgent 拥有创建群所需的 `im:chat` 权限，并确认租户策略允许该操作。

## 开发

```bash
pnpm install
pnpm dev          # watch build
pnpm typecheck
pnpm test
pnpm build
```

回归测试包含 fake OMP JSONL 回放，覆盖非终止 `agent_end` continuation 和 terminal 错误帧。真实飞书端到端测试需要 PersonalAgent 凭据以及可用的飞书 / Lark 环境。

## 当前限制

- 原生 URI 只读，目前只暴露 `current/context` 和单条消息。
- 可用的飞书操作取决于租户权限、网络和 PersonalAgent 能力。
- OMP 仍作为独立子进程运行；模型选择和 provider 凭据由 OMP 自己管理。

## License

MIT
