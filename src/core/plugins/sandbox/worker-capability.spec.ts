import { WorkerCapabilityClient, buildSandboxContext } from './worker-capability';
import { WorkerToHostMessage } from './protocol';
import { WorkerHookRegistry } from './worker-hooks';

describe('WorkerCapabilityClient', () => {
  it('posts a cap request and resolves on the matching cap-result', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));

    const pending = client.call('messages.sendText', ['s', 'c', 'hi']);
    const req = sent[0] as Extract<WorkerToHostMessage, { kind: 'cap' }>;
    expect(req).toMatchObject({ kind: 'cap', verb: 'messages.sendText', args: ['s', 'c', 'hi'] });

    client.handleResult({ kind: 'cap-result', id: req.id, ok: true, result: { messageId: 'm' } });
    await expect(pending).resolves.toEqual({ messageId: 'm' });
  });

  it('rejects on an error cap-result', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));

    const pending = client.call('messages.sendText', []);
    const req = sent[0] as Extract<WorkerToHostMessage, { kind: 'cap' }>;
    client.handleResult({ kind: 'cap-result', id: req.id, ok: false, error: 'permission denied' });

    await expect(pending).rejects.toThrow('permission denied');
  });

  it('correlates concurrent calls by id', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));

    const a = client.call('storage.get', ['a']);
    const b = client.call('storage.get', ['b']);
    const [reqA, reqB] = sent as Extract<WorkerToHostMessage, { kind: 'cap' }>[];
    expect(reqA.id).not.toBe(reqB.id);

    client.handleResult({ kind: 'cap-result', id: reqB.id, ok: true, result: 'B' });
    client.handleResult({ kind: 'cap-result', id: reqA.id, ok: true, result: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('tags a call made inside a hook handler with that dispatch chain, and only that call', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));
    const hooks = new WorkerHookRegistry(m => sent.push(m));
    hooks.register('message:sending', () => {
      void client.call('messages.sendText', ['in-hook']);
      return { continue: true };
    });

    void client.call('messages.sendText', ['outside']); // an ingress handler or a timer
    await hooks.handleHook({
      kind: 'hook',
      id: 1,
      event: 'message:sending',
      data: {},
      source: 't',
      inFlight: ['message:received', 'message:sending'],
    });

    const caps = sent.filter((m): m is Extract<WorkerToHostMessage, { kind: 'cap' }> => m.kind === 'cap');
    expect(caps.map(c => [c.args[0], c.inFlight])).toEqual([
      ['outside', undefined],
      ['in-hook', ['message:received', 'message:sending']],
    ]);
  });

  it('does not tag a call a hook handler defers past the end of its dispatch', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));
    const hooks = new WorkerHookRegistry(m => sent.push(m));
    let fireLater!: () => void;
    const later = new Promise<void>(resolve => (fireLater = resolve));
    hooks.register('message:sent', () => {
      void later.then(() => client.call('messages.sendText', ['later']));
      return { continue: true };
    });

    await hooks.handleHook({ kind: 'hook', id: 1, event: 'message:sent', data: {}, source: 't' });
    fireLater();
    await later;
    await Promise.resolve();

    const caps = sent.filter((m): m is Extract<WorkerToHostMessage, { kind: 'cap' }> => m.kind === 'cap');
    expect(caps.map(c => [c.args[0], c.inFlight])).toEqual([['later', undefined]]);
  });
});

describe('buildSandboxContext', () => {
  it('proxies each capability verb to client.call with positional args', async () => {
    const call = jest.fn().mockResolvedValue('ok');
    const ctx = buildSandboxContext({ call } as unknown as WorkerCapabilityClient);

    await ctx.messages.sendText('s', 'c', 'hi');
    expect(call).toHaveBeenCalledWith('messages.sendText', ['s', 'c', 'hi']);

    await ctx.messages.reply('s', 'c', 'q', 'hi');
    expect(call).toHaveBeenCalledWith('messages.reply', ['s', 'c', 'q', 'hi']);

    await ctx.engine.getGroupInfo('s', 'g');
    expect(call).toHaveBeenCalledWith('engine.getGroupInfo', ['s', 'g']);

    await ctx.engine.getChatHistory('s', 'c@c.us', 20, true);
    expect(call).toHaveBeenCalledWith('engine.getChatHistory', ['s', 'c@c.us', 20, true]);

    await ctx.storage.set('k', { a: 1 });
    expect(call).toHaveBeenCalledWith('storage.set', ['k', { a: 1 }]);
  });
});
