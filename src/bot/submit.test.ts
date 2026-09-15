import { beforeEach, describe, expect, it } from 'vitest';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentRun } from '../agent/types';
import type { MediaCache } from '../media/cache';
import { ActiveRuns } from './active-runs';
import { submitMessageToRun } from './submit';
import { clearOmpCommands, setOmpCommands } from './omp-commands';

async function* emptyEvents() {
  return;
}

function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    chatId: 'oc_test',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'user',
    messageId: 'om_msg1',
    rawContentType: 'text',
    content: 'hello',
    resources: [],
    ...overrides,
  } as NormalizedMessage;
}

function fakeMedia(count: number): Pick<MediaCache, 'resolve'> {
  const paths = Array.from({ length: count }, (_, i) => `/tmp/img-${i}.png`);
  return {
    async resolve() {
      return paths.map((path) => ({ kind: 'image', path, originalName: undefined }));
    },
  } as Pick<MediaCache, 'resolve'>;
}

function runHarness() {
  const activeRuns = new ActiveRuns();
  const prompts: Array<{ kind: string; message: string; imagePaths?: string[]; streamingBehavior?: string }> = [];
  const run: AgentRun = {
    events: emptyEvents(),
    stop: async () => {},
    waitForExit: async () => true,
    async submitPrompt(kind, message, imagePaths, streamingBehavior) {
      prompts.push({ kind, message, imagePaths, streamingBehavior });
      return true;
    },
  };
  const handle = activeRuns.register('scope-1', run);
  return { activeRuns, run, prompts, handle };
}

describe('submitMessageToRun', () => {
  beforeEach(() => {
    // Command cache is process-global; scope-1 must start unknown per test.
    clearOmpCommands('scope-1');
  });

  it('returns false when no active run exists for the scope', async () => {
    const activeRuns = new ActiveRuns();
    const ok = await submitMessageToRun(
      {
        channel: {} as LarkChannel,
        activeRuns,
        media: fakeMedia(0) as MediaCache,
        msg: msg(),
        scope: 'scope-1',
      },
      'steer',
    );
    expect(ok).toBe(false);
  });

  it('submits with the given kind, prompt text, and queues the reply target', async () => {
    const { activeRuns, prompts, handle } = runHarness();
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: msg(), scope: 'scope-1' },
      'follow_up',
    );
    expect(ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.kind).toBe('follow_up');
    expect(prompts[0]!.message).toContain('<bridge_context>');
    expect(prompts[0]!.message).toContain('hello');
    expect(handle.pendingReplyTargets).toEqual(['om_msg1']);
  });

  it('uses textOverride as the message body (e.g. /queue payload)', async () => {
    const { activeRuns, prompts, handle } = runHarness();
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: msg(), scope: 'scope-1' },
      'follow_up',
      'do the thing',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.message).toContain('do the thing');
    expect(prompts[0]!.message).not.toContain('hello');
    // The new reply window still threads to the /queue message itself.
    expect(handle.pendingReplyTargets).toEqual(['om_msg1']);
  });

  it('passes image paths for attachment-bearing messages', async () => {
    const { activeRuns, prompts } = runHarness();
    const m = msg({ resources: [{ fileKey: 'file-key-1' } as never] });
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(1) as MediaCache, msg: m, scope: 'scope-1' },
      'steer',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.kind).toBe('steer');
    expect(prompts[0]!.imagePaths).toEqual(['/tmp/img-0.png']);
    expect(prompts[0]!.message).toContain('附件（本地路径）');
  });

  it('routes slash text via the prompt frame verbatim (steer semantics)', async () => {
    const { activeRuns, prompts, handle } = runHarness();
    const m = msg({ content: '/compact' });
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: m, scope: 'scope-1' },
      'steer',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.kind).toBe('prompt');
    expect(prompts[0]!.message).toBe('/compact');
    expect(prompts[0]!.streamingBehavior).toBe('steer');
    expect(handle.pendingReplyTargets).toEqual(['om_msg1']);
  });

  it('routes /queue payload starting with / via followUp semantics', async () => {
    const { activeRuns, prompts } = runHarness();
    const ok = await submitMessageToRun(
      { channel: {} as LarkChannel, activeRuns, media: fakeMedia(0) as MediaCache, msg: msg(), scope: 'scope-1' },
      'follow_up',
      '/compact keep',
    );
    expect(ok).toBe(true);
    expect(prompts[0]!.kind).toBe('prompt');
    expect(prompts[0]!.message).toBe('/compact keep');
    expect(prompts[0]!.streamingBehavior).toBe('followUp');
  });

  it('routes known commands (name or alias) via the prompt frame once the command list is known', async () => {
    setOmpCommands('scope-1', [
      { name: 'compact', aliases: ['/cc'] },
      { name: 'move' },
    ]);
    const { activeRuns, prompts } = runHarness();
    const args = {
      channel: {} as LarkChannel,
      activeRuns,
      media: fakeMedia(0) as MediaCache,
      scope: 'scope-1',
    };
    await submitMessageToRun({ ...args, msg: msg({ content: '/compact tail' }) }, 'steer');
    await submitMessageToRun({ ...args, msg: msg({ content: '/cc tail' }) }, 'steer');
    await submitMessageToRun({ ...args, msg: msg({ content: '/move over' }) }, 'steer');
    expect(prompts.map((p) => p.kind)).toEqual(['prompt', 'prompt', 'prompt']);
    expect(prompts.map((p) => p.message)).toEqual(['/compact tail', '/cc tail', '/move over']);
  });

  it('treats an unrecognized /-prefixed text as a plain message once the command list is known', async () => {
    setOmpCommands('scope-1', [{ name: 'compact' }]);
    const { activeRuns, prompts } = runHarness();
    const ok = await submitMessageToRun(
      {
        channel: {} as LarkChannel,
        activeRuns,
        media: fakeMedia(0) as MediaCache,
        msg: msg({ content: '/etc/fstab 在哪' }),
        scope: 'scope-1',
      },
      'steer',
    );
    expect(ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.kind).toBe('steer');
    expect(prompts[0]!.message).toContain('/etc/fstab 在哪');
    // Plain steer frames keep the bridge context wrapper instead of the verbatim line.
    expect(prompts[0]!.message).toContain('<bridge_context>');
  });

  it('treats an attachment-bearing /-prefixed message as a plain message', async () => {
    setOmpCommands('scope-1', [{ name: 'compact' }]);
    const { activeRuns, prompts } = runHarness();
    const ok = await submitMessageToRun(
      {
        channel: {} as LarkChannel,
        activeRuns,
        media: fakeMedia(1) as MediaCache,
        msg: msg({ content: '/compact', resources: [{ fileKey: 'f1', type: 'image' }] }),
        scope: 'scope-1',
      },
      'steer',
    );
    expect(ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.kind).toBe('steer');
    expect(prompts[0]!.imagePaths).toEqual(['/tmp/img-0.png']);
  });
});