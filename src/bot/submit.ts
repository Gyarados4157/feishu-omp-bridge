import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { MediaCache, type LocalAttachment } from '../media/cache';
import { ActiveRuns } from './active-runs';
import { getOmpCommands } from './omp-commands';
import { expandInteractiveCard } from './interactive-card';
import { fetchQuotedContext, renderQuotedBlock, type QuotedContext } from './quote';

export interface SubmitMessageToRunDeps {
  channel: LarkChannel;
  activeRuns: ActiveRuns;
  media: MediaCache;
  msg: NormalizedMessage;
  scope: string;
}

/**
 * Submit a single Feishu message into the ACTIVE OMP run for this scope as a
 * steering or follow-up prompt. Returns false when no run is active — the
 * caller then falls through to the debounce queue / a fresh run.
 *
 * `textOverride` replaces the message content (used by `/queue`, which
 * carries its payload as command args) — the reply window still threads to
 * the original message id. When absent, the message text is used verbatim.
 */
export async function submitMessageToRun(
  deps: SubmitMessageToRunDeps,
  kind: 'steer' | 'follow_up',
  textOverride?: string,
): Promise<boolean> {
  const { channel, activeRuns, media, msg, scope } = deps;
  if (!activeRuns.has(scope)) return false;
  const resources = msg.resources.map((resource) => ({ messageId: msg.messageId, resource }));
  const attachments = await media.resolve(msg.chatId, resources);
  const imagePaths = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.path);
  const quotes: QuotedContext[] = [];
  if (!textOverride && msg.replyToMessageId) {
    const quote = await fetchQuotedContext(channel, msg.replyToMessageId);
    if (quote) quotes.push(quote);
  }
  const source = textOverride !== undefined ? { ...msg, content: textOverride } : msg;
  const userText = textOverride ?? msg.content;
  // A message is routed as an OMP slash command only when it is a bare
  // command line: no attachments, no quoted context (consistent with
  // runAgentBatch's isSoloSlash), and its first token matches a known OMP
  // command (name or alias).
  //
  // Before the command list has arrived for this run (OMP pushes
  // `available_commands_update` at run start), any `/`-prefixed line is sent
  // verbatim so real commands still work. Once the list is known, an
  // unrecognized `/`-prefixed text (e.g. a question about `/etc`) falls back
  // to the plain steer/follow-up path and keeps the <bridge_context> wrapper;
  // OMP itself falls back to a normal agent turn for it, so nothing is lost.
  const trimmed = userText.trimStart();
  const firstToken = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
  const knownCommands = getOmpCommands(scope);
  const known =
    knownCommands !== undefined &&
    knownCommands.some(
      (c) =>
        c.name.toLowerCase() === firstToken?.slice(1) ||
        (c.aliases ?? []).some(
          (a) => a.toLowerCase() === firstToken || a.toLowerCase() === firstToken?.slice(1),
        ),
    );
  const isSlashCommand =
    firstToken !== undefined &&
    firstToken.startsWith('/') &&
    attachments.length === 0 &&
    quotes.length === 0 &&
    (known || knownCommands === undefined);
  const prompt = buildPrompt([source], attachments, quotes);
  // Command detection probes the OMP command list; commands are sent through
  // the `prompt` frame with the VERBATIM user text: OMP's slash dispatch
  // parses the first token, so no bridge context / conventions prefix may
  // precede it. Plain steer/follow_up frames only queue TEXT — they never
  // run a command (this is why `/compact` used to do nothing).
  // `streamingBehavior` carries over the caller's interrupt/queue semantics.
  const submitted = isSlashCommand
    ? await activeRuns.submitPrompt(
        scope,
        'prompt',
        userText.trim(),
        imagePaths,
        kind === 'steer' ? 'steer' : 'followUp',
      )
    : await activeRuns.submitPrompt(scope, kind, prompt, imagePaths);
  // The answer must land in a NEW reply window threaded to this message, not
  // appended to the previous reply. Queue it so the next turn boundary's
  // window threads to this message.
  if (submitted) activeRuns.queueReplyTarget(scope, msg.messageId);
  return submitted;
}

export function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const texts = batch
    .map((m) => stripAttachmentRefs(expandedMessageContent(m), fileKeys).trim())
    .filter(Boolean);
  const ctxHeader = buildBridgeContextHeader(batch);
  const quoteBlock = renderQuotedBlock(quotes);

  // Order: <bridge_context> (metadata) → <quoted_message>(s) (what user is
  // pointing at) → user text + attachments (what they're asking).
  const prefixParts = [ctxHeader, quoteBlock].filter(Boolean);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n` : '';

  if (attachments.length === 0) {
    return `${prefix}${texts.join('\n\n')}`;
  }

  const attachLines = attachments.map((a) => {
    const label =
      a.kind === 'image'
        ? '图片'
        : a.kind === 'audio'
          ? '音频'
          : a.kind === 'video'
            ? '视频'
            : '文件';
    const name = a.originalName ? ` (${a.originalName})` : '';
    return `- ${a.path}${name} — ${label}`;
  });
  const userPart = texts.length > 0 ? texts.join('\n\n') : '请看下面的附件。';
  return `${prefix}${userPart}\n\n附件（本地路径）：\n${attachLines.join('\n')}`;
}

function buildBridgeContextHeader(batch: NormalizedMessage[]): string {
  const m = batch[0];
  if (!m) return '';
  const lines = [
    '<bridge_context>',
    `chat_id: ${m.chatId}`,
    `chat_type: ${m.chatType}`,
    `sender_id: ${m.senderId}`,
  ];
  if (m.senderName) lines.push(`sender_name: ${m.senderName}`);
  if (m.threadId) lines.push(`thread_id: ${m.threadId}`);
  lines.push('</bridge_context>');
  return lines.join('\n');
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function expandedMessageContent(m: NormalizedMessage): string {
  if (m.rawContentType !== 'interactive') return m.content;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string') return m.content;
  return expandInteractiveCard(m.content, rawContent);
}