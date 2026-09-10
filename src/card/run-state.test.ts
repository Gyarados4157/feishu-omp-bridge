import { describe, expect, it } from 'vitest';
import { initialState, reduce } from './run-state';

describe('run-state OMP UI integration', () => {
  it('pauses the footer while waiting for native UI input', () => {
    const state = reduce(initialState, {
      type: 'ui_request',
      request: { id: 'ui-1', method: 'input', title: 'Need input', placeholder: 'value' },
    });

    expect(state.footer).toBe('waiting_input');
    expect(state.blocks.at(-1)).toEqual({
      kind: 'text',
      content: '🧩 OMP 需要用户交互：**Need input**\n\n已发送交互卡片，请在那里完成操作。',
      streaming: false,
    });
  });

  it('tracks mutable status and widget updates', () => {
    const withStatus = reduce(initialState, {
      type: 'ui_status',
      status: { key: 'extension', text: 'working' },
    });
    const withWidget = reduce(withStatus, {
      type: 'ui_widget',
      widget: { key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' },
    });
    const cleared = reduce(withWidget, {
      type: 'ui_status',
      status: { key: 'extension', text: undefined },
    });

    expect(withWidget.ui.statuses).toEqual({ extension: 'working' });
    expect(withWidget.ui.widgets.todo).toEqual({ key: 'todo', lines: ['a', 'b'], placement: 'belowEditor' });
    expect(cleared.ui.statuses).toEqual({});
  });

  it('appends partial tool updates before final result', () => {
    const started = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'bash',
      input: { command: 'pwd' },
    });
    const updated = reduce(started, { type: 'tool_update', id: 'tool-1', output: 'working' });
    const done = reduce(updated, { type: 'tool_result', id: 'tool-1', output: 'done', isError: false });

    expect(updated.blocks[0]).toMatchObject({ kind: 'tool', tool: { output: 'working', status: 'running' } });
    expect(done.blocks[0]).toMatchObject({ kind: 'tool', tool: { output: 'done', status: 'done' } });
  });
});
