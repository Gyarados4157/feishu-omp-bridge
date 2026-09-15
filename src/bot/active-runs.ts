import type { AgentRun, AgentUiResponse } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  /**
   * True once the agent stream reached a terminal state (or was torn down).
   * Submission guards on this: a `follow_up` frame written after OMP emitted
   * agent_end is queued into a dead loop and silently never consumed — the
   * message would vanish (observed: mid-run `/usage` sent between agent_end
   * and process reap produced no answer). Terminal runs reject submissions so
   * the message falls back to the debounce queue / a fresh run instead.
   */
  terminal: boolean;
  pendingUiRequests: Set<string>;
  onUiSettled?: () => void;
  /**
   * Feishu message ids that triggered follow-up turns. Each new reply window
   * (one per agent turn) consumes one as its reply target so the answer
   * threads to the message that asked for it.
   */
  pendingReplyTargets: string[];
  /**
   * The target (if any) reserved for the NEXT reply window. Set at a turn
   * boundary when a queued target is consumed; the window opener reads it
   * once and clears it. Lives on the handle so both the stream loop (which
   * reserves it) and the window opener (which consumes it) share it.
   */
  currentReplyTarget?: string;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();

  register(chatId: string, run: AgentRun): RunHandle {
    const handle: RunHandle = {
      run,
      interrupted: false,
      terminal: false,
      pendingUiRequests: new Set(),
      pendingReplyTargets: [],
    };
    this.handles.set(chatId, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.handles.has(chatId);
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  respondToUi(chatId: string, requestId: string, response: AgentUiResponse): boolean {
    const h = this.handles.get(chatId);
    const ok = h?.run.respondToUi?.(requestId, response) === true;
    if (ok) h?.pendingUiRequests.delete(requestId);
    if (ok) h?.onUiSettled?.();
    return ok;
  }

  submitPrompt(
    chatId: string,
    kind: 'steer' | 'follow_up' | 'prompt',
    message: string,
    imagePaths?: string[],
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<boolean> {
    const h = this.handles.get(chatId);
    // No run, or a run whose stream already ended: writing a frame now would
    // queue the text into an engine that will never deliver it. Return false
    // so the caller routes the message through the debounce queue / new run.
    if (!h || h.terminal) return Promise.resolve(false);
    return h.run.submitPrompt?.(kind, message, imagePaths, streamingBehavior) ?? Promise.resolve(false);
  }
  /**
   * Record the Feishu message that triggered a follow-up turn. The running
   * stream consumes one target per new reply window (turn), so the answer
   * threads to the message that asked for it.
   */
  queueReplyTarget(chatId: string, messageId: string): void {
    this.handles.get(chatId)?.pendingReplyTargets.push(messageId);
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}
