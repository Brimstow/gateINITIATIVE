import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, DEFAULT_ROUTES, sendToast } from './notify.mjs';

describe('Notifier', () => {
  it('routes events to configured destinations', async () => {
    const terminals = [];
    const notifier = new Notifier({
      toastEnabled: false,
      routes: DEFAULT_ROUTES,
      terminal: (event) => terminals.push(event.title),
    });

    const warn = await notifier.notify({ severity: 'warn', title: 'warn', message: 'm' });
    assert.ok(warn.includes('terminal'));
    assert.ok(!warn.includes('toast'));
    assert.deepStrictEqual(terminals, ['warn']);

    const block = await notifier.notify({ severity: 'block', title: 'block', message: 'm' });
    assert.ok(block.includes('queue'));
  });

  it('does not fire toast when disabled', async () => {
    const notifier = new Notifier({ toastEnabled: false, routes: DEFAULT_ROUTES });
    const result = await notifier.notify({ severity: 'block', title: 't', message: 'm' });
    assert.ok(!result.includes('toast'));
  });

  it('returns log for unknown severity', async () => {
    const notifier = new Notifier({ routes: {} });
    const result = await notifier.notify({ severity: 'info', title: 't', message: 'm' });
    assert.deepStrictEqual(result, ['log']);
  });

  it('reports toast failures via onToastFailure', async () => {
    let failure;
    const notifier = new Notifier({
      toastEnabled: true,
      routes: { block: ['toast'] },
      onToastFailure: (event) => { failure = event; },
    });
    // Force sendToast to fail by overriding the function on the instance is not possible,
    // but we can at least verify the callback fires on unsupported platforms.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'fakeos', configurable: true });
    try {
      await notifier.notify({ severity: 'block', title: 't', message: 'm' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
    assert.ok(failure);
    assert.ok(failure.message.includes('unsupported platform'));
  });
});

describe('sendToast', () => {
  it('returns unsupported on unknown platform', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'plan9', configurable: true });
    try {
      const result = await sendToast('t', 'm');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('plan9'));
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
