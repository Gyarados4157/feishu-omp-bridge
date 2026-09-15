import { homedir } from 'node:os';
import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentUiRequest } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { renderOmpUiRequestCard, renderOmpUiResultCard } from '../card/omp-ui';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getOmpModel,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isChatAllowed,
  isUserAllowed,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, withTrace } from '../core/logger';
import { MediaCache } from '../media/cache';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { createFeishuHostIntegration } from './feishu-host';
import { startKeepalive } from './keepalive';
import { configureNetwork } from './network-config';
import { setOmpCommands } from './omp-commands';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, type QuotedContext } from './quote';
import { addWorkingReaction, removeReaction } from './reaction';
import { buildPrompt, submitMessageToRun } from './submit';

const DEBOUNCE_MS = 600;
// Feishu CardKit streaming (markdown mode) cards auto-close ~10 minutes
// after creation — SDK note: "Feishu auto-closes after 10min regardless".
// Content updates after that are silently dropped (accepted, never
// rendered), while bridge logs stay perfectly clean. Long-lived agent runs
// (CI waits, background jobs, idle user) routinely cross that cap, so
// rotate markdown windows well before it.
const STREAMING_WINDOW_MAX_AGE_MS = 5 * 60_000;

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  // Match either `{ code: <feishu-code> }` (the response data SDK logs as
  // its second arg) or an AxiosError where the feishu code lives at
  // `err.response.data.code` (which the SDK logs raw).
  const codeFromObj = (m: unknown): number | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const top = (m as { code?: unknown }).code;
    if (typeof top === 'number') return top;
    const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof nested === 'number' ? nested : undefined;
  };
  const isSuppressed = (msg: unknown): boolean => {
    if (Array.isArray(msg)) return msg.some(isSuppressed);
    const code = codeFromObj(msg);
    return code !== undefined && SUPPRESSED_API_ERROR_CODES.has(code);
  };
  return {
    error: (...args: unknown[]) => {
      if (args.some(isSuppressed)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));

  // Apply network-layer overrides (HTTP timeout + proxy from env). Idempotent;
  // safe to call on every startChannel (used by /account change hot-reload too).
  const netOverrides = configureNetwork();

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg);

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-omp-bridge',
    loggerLevel: LoggerLevel.info,
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Optional WS-layer proxy agent (only when HTTPS_PROXY / HTTP_PROXY env set).
    ...(netOverrides.agent ? { agent: netOverrides.agent } : {}),
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', { scope, batchSize: batch.length });
      // Pool slot acquired here, released in finally. Across-the-bridge cap.
      const release = await pool.acquire();
      try {
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        await runAgentBatch({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          batch,
          controls,
          scope,
          mode,
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        release();
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          pending,
          msg,
          controls,
          chatModeCache,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          workspaces,
          activeRuns,
          agent,
          media,
          controls,
          pending,
          chatModeCache,
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({ channel, evt, agent, sessions, workspaces }).catch((err) =>
          log.fail('comment', err),
        );
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();

  const identity = channel.botIdentity;
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      keepalive.stop();
      pending.cancelAll();
      await channel.disconnect();
      await activeRuns.stopAll();
      await Promise.allSettled([sessions.flush(), workspaces.flush()]);
    },
  };
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    pending,
    msg,
    controls,
    chatModeCache,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = chatMode === 'topic' && msg.threadId
    ? `${msg.chatId}:${msg.threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  // Access control. Silent drop — replying would reveal the bot to
  // unauthorized users and let them spam the chat with denial messages.
  // Operator-defined lists; both empty = allow all (back-compat).
  if (!isUserAllowed(controls.cfg, msg.senderId)) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
    });
    return;
  }
  // `allowedChats` is intentionally a group-only gate. p2p chat_ids are
  // generated per-user-pair and can't be hijacked by an unauthorized
  // sender, so the user allowlist above is already authoritative for DMs.
  // Restricting p2p by chat_id would also create a chicken-and-egg lockout
  // hazard (the operator must know the chat_id before they ever DM the bot).
  if (msg.chatType !== 'p2p' && !isChatAllowed(controls.cfg, msg.chatId)) {
    log.info('intake', 'skip-not-allowed-chat', {
      scope,
      chatId: msg.chatId.slice(-6),
    });
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    media,
    controls,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  // `!` prefix: force-interrupt the current turn, then process the message
  // as a FRESH turn once the old run is torn down. Stronger than steer —
  // steer only interrupts an in-flight OMP turn from inside the same run;
  // this also stops the run, marks its card interrupted, drops stale queued
  // prompts, and the message starts a brand-new run (session resumed, so
  // context survives). The pending queue is blocked while the old run is
  // being stopped, so the new turn only starts after it exits.
  const rawText = msg.content.trimStart();
  if (rawText.startsWith('!') && rawText.length > 1) {
    const interrupted = activeRuns.interrupt(scope);
    pending.cancel(scope);
    const rest = rawText.slice(1).trimStart();
    if (rest) {
      pending.push(scope, { ...msg, content: rest });
      log.info('intake', 'interrupt-new-turn', { scope, interrupted, restChars: rest.length });
    } else {
      log.info('intake', 'interrupt-only', { scope, interrupted });
    }
    return;
  }

  // Default mid-run messages are STEER (interrupt path) — no prefix needed.
  if (await submitMessageToRun({ channel, activeRuns, media, msg, scope }, 'steer')) {
    log.info('intake', 'submitted-active-run', { scope });
    return;
  }

  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

interface RunBatchDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  scope: string;
  mode: ChatMode;
}

interface AgentStreamHooks {
  onUiRequest(request: AgentUiRequest): Promise<void>;
  onUiCancel(targetId: string): Promise<void>;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    batch,
    controls,
    scope,
    mode,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(chatId, resourceItems);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
  }
  const imagePaths = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.path);

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => m.replyToMessageId)
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // A single slash command (e.g. `/compact`) starting a fresh run must reach
  // OMP verbatim — the `<bridge_context>` wrapper would hide the leading `/`
  // from the slash parser. Multi-message batches / attached / quoted messages
  // keep the normal prompt (a slash command can't be the first token then).
  const firstText = batch.length === 1 ? (batch[0]?.content ?? '').trimStart() : '';
  const isSoloSlash = batch.length === 1 && attachments.length === 0 && quotes.length === 0 && firstText.startsWith('/');
  const prompt = isSoloSlash ? firstText : buildPrompt(batch, attachments, quotes);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });

  const cwd = workspaces.cwdFor(scope) ?? homedir();
  const resumeFrom = sessions.resumeFor(scope, cwd);
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd });
  } else {
    const stale = sessions.getRaw(scope);
    if (stale && stale.cwd !== cwd) {
      log.info('session', 'stale-cleared', { staleCwd: stale.cwd, newCwd: cwd });
      sessions.clear(scope);
    } else {
      log.info('session', 'fresh', { cwd });
    }
  }

  const feishuHost = createFeishuHostIntegration(channel, {
    scope,
    chatId,
    threadId,
    replyToMessageId: lastMsg.messageId,
    cwd,
  });

  const run = agent.run({
    prompt,
    sessionId: resumeFrom,
    cwd,
    model: getOmpModel(controls.cfg),
    imagePaths,
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    hostTools: feishuHost.tools,
    hostUriSchemes: feishuHost.uriSchemes,
  });
  const handle = activeRuns.register(scope, run);

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };

  // Per-user-message reply windows. The whole run still flows through ONE
  // agent process — no interrupt — but when a follow-up prompt is queued
  // (`pendingReplyTargets`), the current streaming card is finalized and the
  // follow-up's answer opens a fresh one, threaded to the follow-up message
  // instead of appending to the previous reply.
  const threadOpts = mode === 'topic' && threadId ? { replyInThread: true } : {};

  interface StreamCtrl {
    setContent(content: string): Promise<void>;
    update(card: object): Promise<void>;
  }

  interface StreamWindow {
    /** Resolves once the SDK hands over the live stream controller. */
    ctrl: Promise<StreamCtrl>;
    /** Resolves when the window's card has been finalized. */
    done: Promise<{ messageId: string }>;
    /** End the producer so the SDK finalizes (completes) this window. */
    finish: () => void;
    /** True once any content has been painted into the window. */
    painted: boolean;
    /** Original message this window's reply threads to — kept across
     * time-based rotation so rollover cards form one continuous reply. */
    replyTo: string;
    /** When the window was opened (time-based rotation age). */
    openedAt: number;
  }

  const openWindow = (replyTo: string, initialCard: object): StreamWindow => {
    let finish!: () => void;
    let resolveCtrl!: (ctrl: StreamCtrl) => void;
    let rejectCtrl!: (err: unknown) => void;
    const ctrlGate = new Promise<StreamCtrl>((res, rej) => {
      resolveCtrl = res;
      rejectCtrl = rej;
    });
    const gate = new Promise<void>((res) => {
      finish = res;
    });
    const done = (async () => {
      try {
        if (replyMode === 'card') {
          return await channel.stream(
            chatId,
            {
              card: {
                initial: initialCard,
                producer: async (ctrl) => {
                  resolveCtrl(ctrl as unknown as StreamCtrl);
                  await gate;
                },
              },
            },
            { replyTo, ...threadOpts },
          );
        }
        return await channel.stream(
          chatId,
          {
            markdown: async (ctrl) => {
              resolveCtrl(ctrl as unknown as StreamCtrl);
              await gate;
            },
          },
          { replyTo, ...threadOpts },
        );
      } catch (err) {
        rejectCtrl(err);
        throw err;
      }
    })();
    // Observe rejection so a window abandoned after a flush error doesn't
    // surface as an unhandled promise rejection.
    done.catch(() => {
      /* observed */
    });
    return { ctrl: ctrlGate, done, finish, painted: false, replyTo, openedAt: Date.now() };
  };

  // Merge the per-window content (current turn's blocks/reasoning) with the
  // live run status (footer / terminal / ui) for rendering.
  const renderWindowState = (view: RunState, live: RunState): RunState => ({
    ...view,
    footer: live.footer,
    terminal: live.terminal,
    ui: live.ui,
    errorMsg: live.errorMsg,
    idleTimeoutMinutes: live.idleTimeoutMinutes,
  });

  let window: StreamWindow | undefined;
  let windowFailed = false;
  // End a window the same way the final flush does: release the producer,
  // wait for the SDK to complete the card, and recall it if it never
  // received content. Used by finalizeWindow and time-based rotation.
  const finishSeg = async (seg: StreamWindow): Promise<void> => {
    seg.finish();
    const { messageId } = await seg.done;
    if (!seg.painted) {
      // The window was opened (eager placeholder) but never received any
      // content — e.g. the run was interrupted before the first token.
      // Completing it would surface a "(no content)" card; recall it.
      log.info('window', 'recall-unpainted', { messageId });
      await channel.recallMessage(messageId);
    }
  };

  const flushView = async (view: RunState, live: RunState): Promise<void> => {
    if (windowFailed) return;
    const rendered = renderWindowState(view, live);

    // Over-age streaming card in markdown mode: CardKit closed it ~10 min
    // after creation and later updates are silently dropped, so a long run
    // would freeze the card and lose its final answer. Finalize it and
    // continue in a fresh window threaded to the same original message.
    if (window && replyMode === 'markdown' && Date.now() - window.openedAt > STREAMING_WINDOW_MAX_AGE_MS) {
      const seg = window;
      window = undefined;
      try {
        await finishSeg(seg);
      } catch (err) {
        log.fail('window', err, { step: 'rotate-finalize' });
      }
      log.info('window', 'rotated', { ageMs: Date.now() - seg.openedAt });
      window = openWindow(seg.replyTo, renderCard(initialState));
    }

    // Open a window only once there is content to show. Opening one early
    // risks a "(no content)" card when it is finalized.
    if (!window) {
      const hasContent = view.blocks.length > 0 || view.reasoning.content.length > 0;
      if (!hasContent) return;
      const replyTo = handle.currentReplyTarget ?? lastMsg.messageId;
      handle.currentReplyTarget = undefined;
      window = openWindow(
        replyTo,
        renderCard({ ...rendered, blocks: [], reasoning: { content: '', active: false } }),
      );
    }
    try {
      const ctrl = await window.ctrl;
      if (replyMode === 'card') {
        await ctrl.update(renderCard(filterForPrefs(rendered)));
      } else {
        await ctrl.setContent(renderText(filterForPrefs(rendered)));
      }
      window.painted = true;
    } catch (err) {
      windowFailed = true;
      log.fail('window', err);
    }
  };

  const finalizeWindow = async (): Promise<void> => {
    const seg = window;
    window = undefined;
    if (!seg) return;
    try {
      await finishSeg(seg);
    } catch (err) {
      windowFailed = true;
      log.fail('window', err);
    }
  };

  const uiCards = new Map<string, { messageId: string; title: string }>();
  const uiHooks: AgentStreamHooks = {
    async onUiRequest(request) {
      try {
        const existing = uiCards.get(request.id);
        if (existing) {
          await updateManagedCard(channel, existing.messageId, renderOmpUiRequestCard(request, scope));
          existing.title = request.title;
          return;
        }
        const sent = await sendManagedCard(channel, chatId, renderOmpUiRequestCard(request, scope), lastMsg.messageId);
        uiCards.set(request.id, { messageId: sent.messageId, title: request.title });
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: request.id, method: request.method });
      }
    },
    async onUiCancel(targetId) {
      const entry = uiCards.get(targetId);
      if (!entry) return;
      try {
        await updateManagedCard(channel, entry.messageId, renderOmpUiResultCard(entry.title, 'cancelled'));
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: targetId, step: 'cancel-update' });
      }
    },
  };

  // For non-card modes OMP's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack;
  // remove it in finally. Card mode has a visible "正在思考…" footer the
  // moment the initial card lands, so the extra reaction would be redundant.
  const reactionId =
    replyMode === 'card' ? undefined : await addWorkingReaction(channel, lastMsg.messageId);

  try {
    if (replyMode === 'card' || replyMode === 'markdown') {
      // Eager window 1 — the placeholder card shows before the first token,
      // matching the pre-window streaming behavior. If the run ends before
      // anything was painted, finalizeWindow recalls it instead of surfacing
      // a "(no content)" card.
      window = openWindow(lastMsg.messageId, renderCard(initialState));
      await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, flushView, uiHooks, finalizeWindow);
      // Close the last window (no-op if the final follow-up boundary did).
      await finalizeWindow();
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      let finalState: RunState = initialState;
      await processAgentStream(handle, sessions, scope, cwd, idleTimeoutMs, async (_view, live) => {
        finalState = live;
      }, uiHooks);
      const body = renderText(filterForPrefs(finalState));
      if (body.trim()) {
        await channel.send(chatId, { markdown: body }, { replyTo: lastMsg.messageId, ...threadOpts });
      }
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    activeRuns.unregister(scope, run);
    if (reactionId) {
      await removeReaction(channel, lastMsg.messageId, reactionId);
    }
  }
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition.
 *
 * `flush` receives two states:
 *  - `view`: the current window's content (blocks + reasoning), reset when a
 *    new user prompt is pending (see `onBoundary`);
 *  - `live`: the authoritative run state (footer / terminal / ui / errors),
 *    shared across all windows of the run.
 * Window boundaries are driven by the caller via `onBoundary` (fired once a
 * follow-up prompt has been queued on the handle).
 */
async function processAgentStream(
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  idleTimeoutMs: number | undefined,
  flush: (view: RunState, live: RunState) => Promise<void>,
  hooks?: AgentStreamHooks,
  onBoundary?: () => Promise<void>,
): Promise<void> {
  let state: RunState = initialState;
  // Per-window render accumulation. Reset when a follow-up prompt is queued
  // so the follow-up's answer starts in a fresh window.
  let view: RunState = initialState;
  // True when the CURRENT window's turn consists of slash-builtin output
  // (synthetic text). Such a turn has no `done`, so when the next turn
  // boundary rotates the window, finalize the old card as completed instead
  // of leaving it stuck on "streaming…".
  let lastTurnWasCommand = false;

  // Idle watchdog: OMP going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — OMP can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize) or on an OMP
  // native UI prompt that the user must answer from a Feishu card.
  // Pause the watchdog while either a tool or UI request is in flight.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0 || handle.pendingUiRequests.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  handle.onUiSettled = armOrPauseIdle;
  armOrPauseIdle();

  try {
    for await (const evt of handle.run.events) {
      if (handle.interrupted) break;

      // Track tool/UI flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use/ui_request open a window;
      // tool_result/ui response/cancel closes it.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      } else if (evt.type === 'ui_request') {
        handle.pendingUiRequests.add(evt.request.id);
        log.info('agent', 'ui-in-flight', { method: evt.request.method, inFlight: handle.pendingUiRequests.size });
      } else if (evt.type === 'ui_cancel') {
        handle.pendingUiRequests.delete(evt.targetId);
        log.info('agent', 'ui-cancelled', { inFlight: handle.pendingUiRequests.size });
      }
      armOrPauseIdle();

      // New-user-TURN boundary. OMP delivers a queued steer/follow-up as a
      // brand-new turn; `turn_start` is the first event of that turn. All
      // events before it (the tail of the previous turn — remaining tool
      // calls, last streamed tokens) still belong to the PREVIOUS request,
      // so we must not rotate earlier or the new card would mix in the old
      // answer. The old card keeps showing the old request until this turn
      // boundary, exactly as follow-ups are meant to feel.
      //
      // `turn_start` is the ONLY boundary event the stream can produce —
      // slash builtin output arrives as `command_output`, but rpc.ts turns
      // that into a synthetic `turn_start` first (see translateOmpFrame),
      // so this single condition covers both agent turns and slash commands.
      if (evt.type === 'turn_start' && handle.pendingReplyTargets.length > 0) {
        // The previous window was a slash-builtin turn: it finished emitting
        // its output but never saw a `done`. Render it as completed BEFORE
        // rotating, or the old card would keep showing "streaming…" forever.
        if (lastTurnWasCommand) {
          // Completed presentation lives on the live side — renderWindowState
          // reads footer/terminal from `live`, not `view`.
          await flush(view, { ...state, footer: null, terminal: 'done' });
        }
        lastTurnWasCommand = false;
        view = initialState;
        handle.currentReplyTarget = handle.pendingReplyTargets.shift();
        await onBoundary?.();
      }

      if (evt.type === 'text' && evt.fromCommand) {
        lastTurnWasCommand = true;
      }

      if (evt.type === 'system') {
        if (evt.sessionId) {
          const effectiveCwd = evt.cwd ?? cwd;
          sessions.set(scope, evt.sessionId, effectiveCwd);
          log.info('session', 'set', { sessionId: evt.sessionId });
        }
        continue;
      }
      if (evt.type === 'usage') {
        if (evt.costUsd !== undefined) {
          log.info('agent', 'usage', { costUsd: Number(evt.costUsd.toFixed(4)) });
        }
        continue;
      }
      if (evt.type === 'available_commands') {
        setOmpCommands(scope, evt.commands);
        continue;
      }
      if (evt.type === 'ui_request') {
        await hooks?.onUiRequest(evt.request);
      } else if (evt.type === 'ui_cancel') {
        await hooks?.onUiCancel(evt.targetId);
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      view = reduce(view, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(view, state);
      // Stop iterating as soon as we have a terminal state. Some OMP
      // RPC runs may leave stdout open briefly after agent_end, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    // From here on the run cannot consume submitted frames — the agent loop
    // has ended even if the subprocess is still being reaped. Terminal
    // submissions are rejected so messages fall back to a fresh run instead
    // of vanishing into a dead queue.
    handle.terminal = true;
    if (handle.onUiSettled === armOrPauseIdle) handle.onUiSettled = undefined;
    if (timer) clearTimeout(timer);
  }

  // A queued reply target that never got its own turn means OMP ended the
  // run before processing the message (e.g. agent_end raced the frame write).
  // Surface it so lost inputs are visible instead of silently dropped.
  if (handle.pendingReplyTargets.length > 0) {
    log.warn('window', 'unconsumed-reply-targets', {
      scope,
      count: handle.pendingReplyTargets.length,
    });
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "OMP finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  await flush(view, state);
    // Reap the subprocess. Two regimes:
  //  - Interrupted (user /stop, idle watchdog, disconnect): stop() was already
  //    fire-and-forgotten by whoever set handle.interrupted; this awaits it.
  //  - Natural done: agent_end can arrive before OMP has fully closed stdout.
  //    Wait it out so the run exits with
  //    code 0; only SIGTERM as a hung-process safety net.
  if (handle.interrupted) {
    await handle.run.stop();
  } else {
    const exited = await handle.run.waitForExit(POST_DONE_EXIT_GRACE_MS);
    if (!exited) {
      log.warn('agent', 'post-done-timeout', { graceMs: POST_DONE_EXIT_GRACE_MS });
      await handle.run.stop();
    }
  }
}

/**
 * How long to wait for OMP to close stdout after a terminal event before
 * forcing a SIGTERM. Empirically OMP's post-agent_end tail is well under a
 * second; 2s leaves headroom for slow flushes without making the user notice
 * a stall (the card has already rendered terminal state by this point).
 */
const POST_DONE_EXIT_GRACE_MS = 2000;

