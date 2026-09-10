import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AgentEvent, AgentUiNoticeType } from '../types';

interface OmpModel {
  provider?: string;
  id?: string;
  name?: string;
}

interface OmpUsage {
  input?: number;
  output?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: { total?: number };
}

interface OmpMessage {
  usage?: OmpUsage;
}

interface OmpState {
  sessionId?: string;
  model?: OmpModel;
}

interface OmpAssistantEvent {
  type?: string;
  delta?: string;
  toolCall?: unknown;
}

interface OmpFrame {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: OmpState;
  assistantMessageEvent?: OmpAssistantEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: OmpMessage | string;
  partialResult?: unknown;
  method?: string;
  title?: string;
  options?: unknown;
  timeout?: number;
  placeholder?: string;
  prefill?: string;
  promptStyle?: boolean;
  targetId?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: unknown;
  widgetPlacement?: string;
  text?: string;
  url?: string;
  instructions?: string;
}

export interface OmpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export function parseOmpJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isReadyFrame(raw: unknown): boolean {
  return isRecord(raw) && raw.type === 'ready';
}

export function isExtensionUiRequest(raw: unknown): boolean {
  return isRecord(raw) && raw.type === 'extension_ui_request' && typeof raw.id === 'string';
}

export function* translateOmpFrame(raw: unknown): Generator<AgentEvent> {
  if (!isRecord(raw)) return;
  const frame = raw as OmpFrame;

  switch (frame.type) {
    case 'response':
      yield* translateResponse(frame);
      return;
    case 'message_update':
      yield* translateMessageUpdate(frame.assistantMessageEvent);
      return;
    case 'tool_execution_start':
      if (frame.toolCallId && frame.toolName) {
        yield {
          type: 'tool_use',
          id: frame.toolCallId,
          name: frame.toolName,
          input: frame.args ?? {},
        };
      }
      return;
    case 'tool_execution_update':
      if (frame.toolCallId) {
        yield {
          type: 'tool_update',
          id: frame.toolCallId,
          output: renderToolResult(frame.partialResult),
        };
      }
      return;
    case 'tool_execution_end':
      if (frame.toolCallId) {
        yield {
          type: 'tool_result',
          id: frame.toolCallId,
          output: renderToolResult(frame.result),
          isError: frame.isError === true,
        };
      }
      return;
    case 'turn_end':
      if (isRecord(frame.message) && isRecord(frame.message.usage)) {
        yield usageEvent(frame.message.usage as OmpUsage);
      }
      return;
    case 'agent_end':
      yield { type: 'done' };
      return;
    case 'notice':
      if (typeof frame.error === 'string') yield { type: 'error', message: frame.error };
      return;
    case 'extension_ui_request':
      yield* translateExtensionUiRequest(frame);
      return;
    default:
      return;
  }
}

export async function loadOmpImages(imagePaths: readonly string[] | undefined): Promise<OmpImageContent[]> {
  if (!imagePaths || imagePaths.length === 0) return [];
  const images: OmpImageContent[] = [];
  for (const imagePath of imagePaths) {
    const data = await readFile(imagePath);
    images.push({
      type: 'image',
      data: data.toString('base64'),
      mimeType: mimeTypeForPath(imagePath),
    });
  }
  return images;
}

function* translateResponse(frame: OmpFrame): Generator<AgentEvent> {
  if (frame.success === false) {
    yield { type: 'error', message: frame.error || `omp ${frame.command ?? 'command'} failed` };
    return;
  }

  if (frame.command !== 'get_state' || frame.success !== true || !frame.data) return;

  const sessionId = typeof frame.data.sessionId === 'string' ? frame.data.sessionId : undefined;
  const model = formatModel(frame.data.model);
  if (sessionId || model) yield { type: 'system', sessionId, model };
}

function* translateMessageUpdate(evt: OmpAssistantEvent | undefined): Generator<AgentEvent> {
  if (!evt) return;
  if (evt.type === 'text_delta' && typeof evt.delta === 'string') {
    yield { type: 'text', delta: evt.delta };
    return;
  }
  if (evt.type === 'thinking_delta' && typeof evt.delta === 'string') {
    yield { type: 'thinking', delta: evt.delta };
  }
}

function* translateExtensionUiRequest(frame: OmpFrame): Generator<AgentEvent> {
  if (!frame.id || !frame.method) return;
  switch (frame.method) {
    case 'select': {
      const options = stringArray(frame.options);
      if (typeof frame.title === 'string' && options.length > 0) {
        yield {
          type: 'ui_request',
          request: { id: frame.id, method: 'select', title: frame.title, options, timeout: frame.timeout },
        };
      }
      return;
    }
    case 'confirm':
      if (typeof frame.title === 'string' && typeof frame.message === 'string') {
        yield {
          type: 'ui_request',
          request: {
            id: frame.id,
            method: 'confirm',
            title: frame.title,
            message: frame.message,
            timeout: frame.timeout,
          },
        };
      }
      return;
    case 'input':
      if (typeof frame.title === 'string') {
        yield {
          type: 'ui_request',
          request: {
            id: frame.id,
            method: 'input',
            title: frame.title,
            placeholder: frame.placeholder,
            timeout: frame.timeout,
          },
        };
      }
      return;
    case 'editor':
      if (typeof frame.title === 'string') {
        yield {
          type: 'ui_request',
          request: {
            id: frame.id,
            method: 'editor',
            title: frame.title,
            prefill: frame.prefill,
            promptStyle: frame.promptStyle,
          },
        };
      }
      return;
    case 'cancel':
      if (typeof frame.targetId === 'string') yield { type: 'ui_cancel', targetId: frame.targetId };
      return;
    case 'notify':
      if (typeof frame.message === 'string') {
        yield { type: 'ui_notice', message: frame.message, level: noticeType(frame.notifyType) };
      }
      return;
    case 'setStatus':
      if (typeof frame.statusKey === 'string') {
        yield { type: 'ui_status', status: { key: frame.statusKey, text: frame.statusText } };
      }
      return;
    case 'setWidget':
      if (typeof frame.widgetKey === 'string') {
        yield {
          type: 'ui_widget',
          widget: {
            key: frame.widgetKey,
            lines: stringArrayOrUndefined(frame.widgetLines),
            placement: widgetPlacement(frame.widgetPlacement),
          },
        };
      }
      return;
    case 'setTitle':
      if (typeof frame.title === 'string') yield { type: 'ui_title', title: frame.title };
      return;
    case 'set_editor_text':
      if (typeof frame.text === 'string') yield { type: 'ui_editor_text', text: frame.text };
      return;
    case 'open_url':
      if (typeof frame.url === 'string') {
        yield { type: 'ui_open_url', url: frame.url, instructions: frame.instructions };
      }
      return;
    default:
      return;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  const items = stringArray(value);
  return items.length > 0 ? items : undefined;
}

function noticeType(value: unknown): AgentUiNoticeType | undefined {
  return value === 'info' || value === 'warning' || value === 'error' ? value : undefined;
}

function widgetPlacement(value: unknown): 'aboveEditor' | 'belowEditor' | undefined {
  return value === 'aboveEditor' || value === 'belowEditor' ? value : undefined;
}

function usageEvent(usage: OmpUsage): AgentEvent {
  return {
    type: 'usage',
    inputTokens: typeof usage.input === 'number' ? usage.input : usage.inputTokens,
    outputTokens: typeof usage.output === 'number' ? usage.output : usage.outputTokens,
    costUsd: usage.cost?.total,
  };
}

function renderToolResult(result: unknown): string {
  if (!isRecord(result)) return result === undefined ? '' : String(result);
  const content = result.content;
  if (!Array.isArray(content)) return stableStringify(result);
  return content.map(renderContentBlock).filter(Boolean).join('\n');
}

function renderContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!isRecord(block)) return stableStringify(block);
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'image') return '[image]';
  return stableStringify(block);
}

function formatModel(model: OmpModel | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.id || model.name;
  if (!id) return undefined;
  return model.provider ? `${model.provider}/${id}` : id;
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.png':
    default:
      return 'image/png';
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
