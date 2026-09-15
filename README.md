# feishu-omp-bridge

[中文文档](README.zh.md)

Bridge Feishu/Lark messages to a local [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) agent. The bridge receives direct messages, group mentions, topic messages, and document-comment mentions, sends them to `omp --mode rpc`, and streams the result back to Feishu as a card or Markdown.

> **Security warning:** OMP can read and modify files and run local commands. A Feishu message can therefore cause actions on the machine running the bridge. Use the access controls and tool allowlist described below before exposing the bot to a group.

## What it provides

- Separate OMP sessions, working directories, queues, and active runs per chat or topic.
- Streaming assistant text, thinking, tool calls, tool updates, token usage, and errors.
- OMP native `confirm`, `select`, `input`, and `editor` requests rendered as Feishu interactive cards.
- OMP extension UI events (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, and `open_url`).
- Feishu-native OMP host tools:
  - `feishu_current_context`
  - `feishu_send_message`
  - `feishu_reply_message`
  - `feishu_get_message`
- Read-only OMP URI resources:
  - `feishu://current/context`
  - `feishu://message/<message_id>`
- Images and files downloaded to a local cache; images are sent to OMP as RPC image content.
- Messages sent to a running chat are delivered as `steer` (interrupting the current turn); `/queue <message>` schedules a follow-up answer on a fresh card after the current turn completes; OMP builtin slash commands (e.g. `/usage`, `/stats`) are executed by OMP rather than answered as text.
- A leading `!` (e.g. `!stop thinking about that`) force-interrupts: the active run is stopped and its card marked interrupted, stale queued prompts are dropped, and the message starts a brand-new turn in a fresh run (the session is resumed, so context survives). Stronger than steer, which interrupts only from inside the same run.
- A foreground mode and an OS-managed background daemon.

## Requirements

- Node.js `>=20`
- pnpm
- A working Oh My Pi installation and a configured model/provider
- A Feishu or Lark PersonalAgent application

Install and configure OMP using its official documentation. For example, the OMP installer supports macOS and Linux:

```bash
curl -fsSL https://omp.sh/install | sh
omp --version
```

Run OMP once as the same operating-system user that will run the bridge and complete its model/authentication setup. Verify that the RPC executable is available:

```bash
omp --mode rpc
```

The command should print a JSON `ready` frame and wait for input; press `Ctrl-C` after the smoke test. If OMP is installed through Bun, nvm, Homebrew, or another user-local toolchain, read [Daemon PATH](#daemon-path-and-credentials) before using `start`.

## Install and build from source

```bash
git clone https://github.com/Gyarados4157/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
```

The repository entry point is `bin/feishu-omp-bridge.mjs`. After building, all examples below can be run with:

```bash
node bin/feishu-omp-bridge.mjs <command>
```

If the package is installed or linked globally, the equivalent command is:

```bash
feishu-omp-bridge <command>
```

## First run

Start the bridge in the foreground:

```bash
node bin/feishu-omp-bridge.mjs run
```

If no complete app configuration exists, the bridge starts a QR-code wizard. Scan the QR code with the Feishu app to create/register the PersonalAgent application. The wizard stores the app configuration under `~/.feishu-omp-bridge/` and, when the scanner identity is available, seeds it as the initial administrator.

The `run` command is a normal foreground process. Keep the terminal open and press `Ctrl-C` to stop it. Running the CLI without a subcommand is also equivalent to `run`:

```bash
node bin/feishu-omp-bridge.mjs
```

Useful first-run options:

```bash
# Skip the optional lark-cli install/bind check
node bin/feishu-omp-bridge.mjs run --skip-check-lark-cli

# Use a non-default config for a foreground process
node bin/feishu-omp-bridge.mjs run --config /path/to/config.json
```

The `start` command does not run the wizard and does not accept `--config`; configure the default file with `run` first if necessary.

## Foreground vs. daemon

These are deliberately different commands:

| Command | Meaning |
| --- | --- |
| `run` | Run one bridge process in the current terminal. |
| `start` | Install/rewrite and start an OS-managed daemon. |
| `stop` | Stop the daemon and disable its automatic start behavior; keep its registration. |
| `restart` | Restart the registered daemon without removing its registration. |
| `status` | Show daemon state, PID, and log paths. |
| `unregister` | Stop the daemon and remove the OS service registration. Bridge data is kept. |
| `ps` | List bridge processes, including foreground processes. |
| `kill <id\|index>` | Send a termination signal to a process shown by `ps`; `index` is the 1-based row number. |

A daemon is not a second implementation of the bot. `start` generates an OS service whose actual command is equivalent to:

```text
node <bridge-entry-point> run
```

Consequently, after changing source code or rebuilding, run `start` again so the service definition captures the current Node executable, entry point, and PATH.

### Start and manage the daemon

```bash
node bin/feishu-omp-bridge.mjs start
node bin/feishu-omp-bridge.mjs status
node bin/feishu-omp-bridge.mjs restart
node bin/feishu-omp-bridge.mjs stop
node bin/feishu-omp-bridge.mjs unregister
```

`start` performs the optional interactive `lark-cli` preflight before installing the service. To skip it:

```bash
node bin/feishu-omp-bridge.mjs start --skip-check-lark-cli
```

Supported service managers:

| Platform | Service manager | Registration |
| --- | --- | --- |
| macOS | launchd user agent | `ai.feishu-omp-bridge.bot` |
| Linux | systemd user unit | `feishu-omp-bridge.bot.service` |
| Windows | Windows Task Scheduler | `FeishuOmpBridge.Bot` |

For a Linux user service to survive logout, the user account may need systemd lingering enabled:

```bash
loginctl enable-linger "$USER"
```

### Secret-store commands

The wizard normally manages the encrypted App Secret automatically. These commands are available for maintenance:

```bash
feishu-omp-bridge secrets list
feishu-omp-bridge secrets set --app-id cli_xxx
feishu-omp-bridge secrets remove --app-id cli_xxx
```

`secrets get` is an internal JSON-over-stdin provider used by `lark-cli`; it is not a general-purpose secret printer.

## Daemon PATH and credentials

Service managers do not necessarily load `.zshrc`, `.bashrc`, or a shell profile. The bridge therefore captures the current `PATH` whenever `start` installs/re-writes the service. Start it from the same user shell in which these commands work:

```bash
command -v node
command -v omp
omp --version
```

Important details:

1. Do not run `start` with `sudo`. The service is per-user and OMP authentication/session files belong to that user.
2. If `omp` is not on the service PATH, set an absolute path in `preferences.ompBinary`, for example `/Users/me/.bun/bin/omp` or `/home/me/.local/bin/omp`.
3. A script installed with `#!/usr/bin/env bun` also needs the Bun directory on `PATH`; an absolute script path alone may not be enough.
4. Re-run `start` after changing Node, Bun, OMP, or PATH so the generated service is refreshed.
5. The daemon captures `PATH`, not arbitrary API-key exports from an interactive shell. Prefer OMP's persistent login/configuration for the same OS user. If a provider depends on an environment variable, make that variable available to the service manager rather than assuming a shell profile will be sourced.

The generated service files and daemon logs are useful when foreground `run` works but `start` does not:

- macOS plist: `~/Library/LaunchAgents/ai.feishu-omp-bridge.bot.plist`
- Linux unit: `${XDG_CONFIG_HOME:-~/.config}/systemd/user/feishu-omp-bridge.bot.service`
- Windows launcher: `~/.feishu-omp-bridge/daemon-launcher.cmd`

## Configuration

The default configuration file is:

```text
~/.feishu-omp-bridge/config.json
```

The QR wizard writes the app credentials and normally moves the App Secret into the local encrypted keystore. A generated configuration resembles:

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

### `preferences`

| Field | Default | Description |
| --- | --- | --- |
| `ompBinary` | `omp` | OMP executable name or absolute path. |
| `ompModel` | OMP default | Model passed to `omp --model`. |
| `ompThinking` | OMP default | Thinking level passed to `omp --thinking`. |
| `ompSessionDir` | `~/.feishu-omp-bridge/omp-sessions` | Directory used for bridge-owned OMP sessions. |
| `ompTools` | OMP default | Comma-separated allowlist passed to `omp --tools`. |
| `messageReply` | `markdown` | `card`, streaming `markdown`, or one-shot `text`. `card` provides the richest UI. |
| `showToolCalls` | `true` | Show tool call panels/lines in the reply. |
| `maxConcurrentRuns` | `10` | Global concurrent-run limit; values are clamped to `1..50`. |
| `runIdleTimeoutMinutes` | disabled | Kill a run after no stream event; values are clamped to `1..120`. `0` disables it. |
| `requireMentionInGroup` | `true` | Require `@bot` in regular and topic groups. Direct messages are unaffected. |
| `agentStopGraceMs` | `5000` | Milliseconds between SIGTERM and the OMP SIGKILL fallback; clamped to `100..30000`. |
| `access` | unrestricted | User/chat allowlists and administrator IDs; see below. |

`messageReply: "text"` means a single Markdown message is sent when the run finishes. It does not mean unformatted plain text. The legacy `codexBinary` and `codexModel` fields are still accepted as fallbacks for older configuration files.

### Access control

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

- An empty or missing `allowedUsers` list allows all users.
- An empty or missing `allowedChats` list allows all group chats.
- An empty or missing `admins` list gives administrator access to every allowed user.
- Administrator-only commands include `/account`, `/config`, `/exit`, `/reconnect`, `/doctor`, `/cd`, and `/ws`.

## Feishu commands

| Command | Action |
| --- | --- |
| `/new` or `/reset` | Clear the current chat/topic session. |
| `/new chat [name]` | Create a new group and invite the sender; requires `im:chat`. |
| `/cd <absolute-path\|~/path>` | Change the current working directory and reset the session. |
| `/ws list` | List named workspaces. |
| `/ws save <name>` | Save the current working directory under a name. |
| `/ws use <name>` | Switch to a named workspace and reset the session. |
| `/ws remove <name>` | Delete a named workspace. |
| `/config` | Open the preferences card. |
| `/account` | Replace bot app credentials and reconnect. |
| `/status` | Show scope, working directory, session, and agent information. |
| `/stop` | Stop the active OMP run for this chat/topic. |
| `/queue <message>` | Schedule the message as a follow-up, answered on a fresh card after the current turn completes. |
| `/timeout [N\|off\|default]` | Set, disable, or reset the idle timeout for this session. `N` is `1..120` minutes. |
| `/ps` | List bridge processes on the machine. |
| `/exit <id\|index>` | Stop a selected bridge process; `index` is the 1-based `/ps` row number. |
| `/reconnect` | Reconnect the Feishu WebSocket. |
| `/doctor [description]` | Ask OMP to inspect recent sanitized logs and the problem description. |
| `/help` | Show the help card. |

Group messages normally require `@bot`; direct messages do not. `@everyone` is not treated as a bot mention.

## OMP RPC lifecycle

The bridge consumes OMP's JSONL RPC stream. A successful `prompt` response normally means only that the command was accepted; it is not the end of the agent turn. Agent turns finish on a terminal `agent_end` event:

- `isTerminal: false` means the event is an intermediate settle and OMP may emit more events (for example, an asynchronous continuation).
- `isTerminal: true` means the run is finished.
- Older OMP versions may omit `isTerminal`; an omitted field is treated as terminal for backward compatibility.
- Local-only prompts, such as slash commands handled by OMP without invoking the agent, finish through `data.agentInvoked: false` on the prompt response or a `prompt_result` frame.

This distinction prevents a newer OMP from being cut off after an intermediate event, which previously could leave the final Feishu reply as `(no content)`. The adapter also reports a clean OMP EOF before a terminal event as an error instead of silently converting it into an empty successful card.

After upgrading the bridge from source, rebuild and refresh the daemon:

```bash
pnpm build
node bin/feishu-omp-bridge.mjs start
```

## Logs and data

All bridge state is kept under `~/.feishu-omp-bridge/` by default:

| Path | Purpose |
| --- | --- |
| `config.json` | App configuration, secret references, and preferences. |
| `secrets.enc` | Encrypted local App Secret keystore. |
| `.keystore.salt` | Keystore salt. |
| `secrets-getter` | Private exec-provider wrapper for the keystore. |
| `sessions.json` | OMP session ID, working directory, and per-session timeout overrides. |
| `omp-sessions/` | Bridge-owned OMP JSONL session files. |
| `workspaces.json` | Named workspace mappings. |
| `processes.json` | Local bridge process registry. |
| `media/` | Downloaded Feishu image/file cache. |
| `logs/` | Structured logs and daemon stdout/stderr logs. |

For daemon output:

```bash
tail -f ~/.feishu-omp-bridge/logs/daemon-stdout.log
tail -f ~/.feishu-omp-bridge/logs/daemon-stderr.log
```

## Troubleshooting

### `omp` cannot be found

Run `omp --version` in the same user account and shell used to install the daemon. Set an absolute `preferences.ompBinary` path when necessary, make sure its runtime (such as Bun) is also on the daemon PATH, then run `start` again.

### Foreground `run` works, daemon `start` does not

Check the generated service and the daemon logs. `start` captures PATH at install time but does not source shell startup files or copy arbitrary exported API keys. Complete OMP authentication as the service user, configure credentials persistently, and reinstall the service after environment changes.

### The final reply is `(no content)`

Build the current bridge and restart the daemon so the updated RPC adapter is running:

```bash
pnpm build
node bin/feishu-omp-bridge.mjs restart
```

If the service was never installed, use `start` instead. Then inspect both daemon logs. A terminal provider error should now be rendered as an agent failure; a missing terminal `agent_end` is reported as an adapter error rather than a successful empty run.

### OMP starts but produces no answer

Run OMP independently as the same user and verify its model/provider configuration. Look for authentication, quota, network, and provider errors in `daemon-stderr.log` and the structured logs. The bridge cannot provide an answer when OMP itself cannot authenticate or reach its provider.

### Group messages are ignored

Mention the bot, or set `preferences.requireMentionInGroup` to `false`. Also check `allowedUsers` and `allowedChats`.

### A run is stuck

Use `/stop` to terminate it. You can set `/timeout 10` for the current session or configure `runIdleTimeoutMinutes` globally. The idle watchdog pauses while OMP is waiting for a tool or native UI response.

### OMP asks for confirmation or input

Complete the separate OMP interaction card in Feishu. The idle watchdog is paused while that request is pending.

### Feishu API tools are unavailable

The bridge's native Feishu host tools do not require `lark-cli`. If you also want OMP to use the traditional CLI tools, install and bind it when prompted, or run:

```bash
npm install -g @larksuite/cli
lark-cli config bind --source lark-channel --identity bot-only
```

### `/new chat` fails

Check that the PersonalAgent has the required group-creation permission (`im:chat`) and that the tenant allows the operation.

## Development

```bash
pnpm install
pnpm dev          # watch build
pnpm typecheck
pnpm test
pnpm build
```

The regression suite includes fake-OMP JSONL playback for RPC lifecycle events, including non-terminal `agent_end` continuation frames and terminal error frames. Real Feishu end-to-end tests require PersonalAgent credentials and a live Feishu/Lark environment.

## Current limitations

- The native URI surface is read-only and currently exposes only `current/context` and individual messages.
- Feishu tenant permissions, network reachability, and PersonalAgent capabilities determine which Feishu operations work.
- OMP remains a separate child process; its provider credentials and model selection are managed by OMP.

## License

MIT
