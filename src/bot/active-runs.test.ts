import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentUiResponse } from '../agent/types';
import { ActiveRuns } from './active-runs';

async function* emptyEvents() {
  return;
}

describe('ActiveRuns OMP UI routing', () => {
  it('routes UI responses to the active run and clears pending request state', () => {
    const activeRuns = new ActiveRuns();
    const responses: Array<{ id: string; response: AgentUiResponse }> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      respondToUi(id, response) {
        responses.push({ id, response });
        return true;
      },
    };

    const handle = activeRuns.register('scope-1', run);
    handle.pendingUiRequests.add('ui-1');
    let settled = 0;
    handle.onUiSettled = () => {
      settled += 1;
    };

    expect(activeRuns.respondToUi('scope-1', 'ui-1', { confirmed: true })).toBe(true);
    expect(responses).toEqual([{ id: 'ui-1', response: { confirmed: true } }]);
    expect(handle.pendingUiRequests.has('ui-1')).toBe(false);
    expect(settled).toBe(1);
  });

  it('returns false when no active run can accept the response', () => {
    expect(new ActiveRuns().respondToUi('missing', 'ui-1', { cancelled: true })).toBe(false);
  });

  it('routes mid-run prompts to the active run', async () => {
    const activeRuns = new ActiveRuns();
    const prompts: Array<{ kind: string; message: string; imagePaths?: string[] }> = [];
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      async submitPrompt(kind, message, imagePaths) {
        prompts.push({ kind, message, imagePaths });
        return true;
      },
    };

    activeRuns.register('scope-1', run);

    await expect(activeRuns.submitPrompt('scope-1', 'follow_up', 'next', ['a.png'])).resolves.toBe(true);
    expect(activeRuns.has('scope-1')).toBe(true);
    expect(prompts).toEqual([{ kind: 'follow_up', message: 'next', imagePaths: ['a.png'] }]);
  });

  it('rejects submissions once the run stream has ended (terminal guard)', async () => {
    // Writing a follow_up/prompt frame into a run whose stream already ended
    // queues the text into a dead loop that never delivers it — the message
    // would vanish silently. The terminal guard returns false so callers
    // route the message through the debounce queue / a fresh run instead.
    const activeRuns = new ActiveRuns();
    let submitted = 0;
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
      async submitPrompt() {
        submitted += 1;
        return true;
      },
    };

    const handle = activeRuns.register('scope-1', run);
    handle.terminal = true;

    await expect(activeRuns.submitPrompt('scope-1', 'follow_up', 'next')).resolves.toBe(false);
    expect(activeRuns.submitPrompt('scope-1', 'prompt', '/usage')).resolves.toBe(false);
    expect(submitted).toBe(0);
  });
  it('queues follow-up reply targets in submission order', () => {
    const activeRuns = new ActiveRuns();
    const run: AgentRun = {
      events: emptyEvents(),
      stop: async () => {},
      waitForExit: async () => true,
    };

    const handle = activeRuns.register('scope-1', run);
    activeRuns.queueReplyTarget('scope-1', 'msg-1');
    activeRuns.queueReplyTarget('scope-1', 'msg-2');
    expect(handle.pendingReplyTargets).toEqual(['msg-1', 'msg-2']);
    expect(handle.pendingReplyTargets.shift()).toBe('msg-1');

    // Unknown scope is a no-op.
    expect(() => activeRuns.queueReplyTarget('missing', 'msg-3')).not.toThrow();
    expect(handle.pendingReplyTargets).toEqual(['msg-2']);
  });
});
