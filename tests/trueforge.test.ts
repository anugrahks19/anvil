import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { ForgeClient, type ForgeEvent, listTrueForgeModels, registerCustomModelProvider, registerModelProvider } from '../src/trueforge/client';

const options = {
  baseUrl: 'http://127.0.0.1:8790',
  modelName: 'custom/test-model',
  mcpServerName: 'anvil-editor',
};

test('session uses the checked-in agent definition with the selected model', async () => {
  let spec: any;
  const api = { sessions: {
    create: async (input: any) => { spec = input.agent.spec; return { data: { id: 'session-1' } }; },
    createTurnStream: async () => (async function* () {
      yield { id: 'event-1', type: 'turn.created', turnId: 'turn-1' };
      yield { id: 'event-2', type: 'turn.done', state: { status: 'done' } };
    })(),
  } } as unknown as TrueForge;
  const client = new ForgeClient(options, api);
  const run = await client.start('hello', () => {});
  await run.done;
  assert.equal(spec.model.name, 'custom/test-model');
  assert.equal(spec.mcpServers[0].name, 'anvil-editor');
  assert.ok(spec.mcpServers[0].requireApprovalForTools.includes('apply_reviewed_proposal'));
});

test('approval waits for the paused event and subscribes before responding', async () => {
  const calls: string[] = [];
  let approveRequest: Promise<void> | undefined;
  let paused = false;
  const api = { sessions: {
    create: async () => ({ data: { id: 'session-1' } }),
    createTurnStream: async () => (async function* () {
      yield { id: 'event-1', type: 'turn.created', turnId: 'turn-1' };
      yield {
        id: 'source-1', type: 'model.message', threadId: 'main',
        toolCalls: [{ id: 'call-1', toolInfo: { name: 'call_tool' }, function: { arguments: '{"mcp_server":"anvil-editor","tool_name":"apply_reviewed_proposal","input":{"proposal_id":"p1"}}' } }],
      };
      yield { id: 'event-2', type: 'tool.approval_required', threadId: 'main', toolCalls: [{ id: 'call-1', sourceEventId: 'source-1' }] };
      paused = true;
      yield { id: 'event-3', type: 'turn.update', state: { status: 'paused' } };
    })(),
    subscribeToTurn: async () => {
      calls.push('subscribe');
      return (async function* () {
        yield { id: 'event-4', type: 'tool.response', toolCallId: 'call-1', content: '{"applied":true,"proposal_id":"p1"}' };
        yield { id: 'event-5', type: 'turn.done', state: { status: 'done' } };
      })();
    },
    createTurnEvents: async (_session: string, _turn: string, input: any) => {
      assert.equal(paused, true);
      assert.equal(input.events[0].toolCallId, 'call-1');
      calls.push('respond');
    },
  } } as unknown as TrueForge;
  const client = new ForgeClient(options, api);
  const events: ForgeEvent[] = [];
  const run = await client.start('edit', event => {
    events.push(event);
    if (event.type === 'approval') approveRequest = client.approve(event.toolCallId, true);
  });
  await run.done;
  await approveRequest;
  assert.deepEqual(calls, ['subscribe', 'respond']);
  assert.ok(events.some(event => event.type === 'approval' && event.name === 'apply_reviewed_proposal' && event.args === '{"proposal_id":"p1"}'));
  assert.ok(events.some(event => event.type === 'tool' && event.name === 'apply_reviewed_proposal' && event.isError === false));
});

test('terminal model failure reaches the caller and start errors do not reject hidden promises', async () => {
  const failureApi = { sessions: {
    create: async () => ({ data: { id: 'session-1' } }),
    createTurnStream: async () => (async function* () {
      yield { id: 'event-1', type: 'turn.created', turnId: 'turn-1' };
      yield { id: 'event-2', type: 'turn.done', state: { status: 'error', message: 'Invalid model key' } };
    })(),
  } } as unknown as TrueForge;
  const events: ForgeEvent[] = [];
  const run = await new ForgeClient(options, failureApi).start('edit', event => events.push(event));
  await assert.rejects(run.done, /Invalid model key/);
  assert.ok(events.some(event => event.type === 'error' && /Invalid model key/.test(event.message)));

  const startApi = { sessions: { create: async () => { throw new Error('server unavailable'); } } } as unknown as TrueForge;
  await assert.rejects(new ForgeClient(options, startApi).start('edit', () => {}), /server unavailable/);
});

test('resume sends a new turn in the same session after a rate-limit failure', async () => {
  let sessionCreates = 0;
  const prompts: string[] = [];
  const api = { sessions: {
    create: async () => { sessionCreates++; return { data: { id: 'session-retry' } }; },
    createTurnStream: async (_session: string, input: any) => {
      prompts.push(input.input[0].content);
      const retry = prompts.length > 1;
      return (async function* () {
        yield { id: retry ? 'turn-2-created' : 'turn-1-created', type: 'turn.created', turnId: retry ? 'turn-2' : 'turn-1' };
        yield retry
          ? { id: 'turn-2-done', type: 'turn.done', state: { status: 'done' } }
          : { id: 'turn-1-done', type: 'turn.done', state: { status: 'error', message: '429 quota exceeded' } };
      })();
    },
  } } as unknown as TrueForge;
  const client = new ForgeClient(options, api);
  const first = await client.start('Make a multi-file change', () => {});
  await assert.rejects(first.done, /429 quota exceeded/);
  const resumed = await client.resume('Continue the same task from the staged proposal', () => {});
  await resumed.done;
  assert.equal(first.sessionId, resumed.sessionId);
  assert.equal(sessionCreates, 1);
  assert.deepEqual(prompts, ['Make a multi-file change', 'Continue the same task from the staged proposal']);
});

test('surfaces deferred call_tool invocations and context compaction events', async () => {
  const api = { sessions: {
    create: async () => ({ data: { id: 'session-ce' } }),
    createTurnStream: async () => (async function* () {
      yield { id: 'e1', type: 'turn.created', turnId: 't1' };
      yield { id: 'e2', type: 'thread.context_compaction_started' satisfies TrueForgeApi.ThreadContextCompactionStartedEvent['type'], threadId: 'main' };
      yield { id: 'e3', type: 'thread.context_compaction_finished' satisfies TrueForgeApi.ThreadContextCompactionFinishedEvent['type'], threadId: 'main' };
      yield {
        id: 'e4', type: 'model.message', threadId: 'main',
        toolCalls: [{ id: 'c1', toolInfo: { name: 'call_tool' }, function: { arguments: '{"mcp_server":"anvil-editor","tool_name":"find_symbol","input":{"name":"Flask"}}' } }],
      };
      yield { id: 'e5', type: 'tool.response', toolCallId: 'c1', content: '{"symbols":[]}' };
      yield { id: 'e6', type: 'turn.done', state: { status: 'done' } };
    })(),
  } } as unknown as TrueForge;
  const events: ForgeEvent[] = [];
  const run = await new ForgeClient(options, api).start('find symbol', event => events.push(event));
  await run.done;
  assert.ok(events.some(event => event.type === 'compaction' && event.phase === 'started' && event.threadId === 'main'));
  assert.ok(events.some(event => event.type === 'compaction' && event.phase === 'finished' && event.threadId === 'main'));
  assert.ok(events.some(event => event.type === 'tool' && event.name === 'find_symbol' && event.deferred === true));
});

test('lists TrueForge providers and registers an offline OpenAI-compatible model without replacing existing local models', async () => {
  let savedManifest: any;
  const api = {
    settings: {
      modelProviders: {
        list: async () => ({
          data: [
            {
              name: 'local-ollama',
              manifest: {
                type: 'custom',
                name: 'local-ollama',
                baseUrl: 'http://127.0.0.1:11434/v1',
                models: [{ modelId: 'llama3.1:8b', name: 'llama3-1-8b', properties: { contextLength: 32768 } }],
              },
            },
          ],
        }),
        createOrUpdate: async (req: any) => {
          savedManifest = req.manifest;
          return { data: req };
        },
      },
    },
  } as unknown as TrueForge;

  const initial = await listTrueForgeModels(options.baseUrl, api);
  assert.deepEqual(initial, [{ fullName: 'local-ollama/llama3-1-8b', contextLength: 32768 }]);

  const registered = await registerCustomModelProvider(options.baseUrl, {
    providerName: 'local-ollama',
    endpointUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen2.5-coder:7b',
    contextLength: 16384,
  }, api);
  assert.equal(registered, 'local-ollama/qwen2-5-coder-7b');
  assert.equal(savedManifest.type, 'custom');
  assert.equal(savedManifest.auth, undefined);
  assert.equal(savedManifest.models.length, 2);
  assert.deepEqual(savedManifest.models[1], {
    modelId: 'qwen2.5-coder:7b',
    name: 'qwen2-5-coder-7b',
    properties: { contextLength: 16384 },
  });
});

test('loop-breaker guard cancels runaway repeated failing tool calls for fast fallback', async () => {
  let cancelledSession = '';
  const api = {
    sessions: {
      create: async () => ({ data: { id: 'session-loop' } }),
      cancel: async (sid: string) => { cancelledSession = sid; },
      createTurnStream: async () => (async function* () {
        yield { id: 'e0', type: 'turn.created', turnId: 't1' };
        for (let i = 1; i <= 3; i++) {
          yield {
            id: `m${i}`, type: 'model.message', threadId: 'main',
            toolCalls: [{ id: `c${i}`, toolInfo: { name: 'propose_edit' }, function: { arguments: '{"path":"a.py"}' } }],
          };
          const payload = i === 3
            ? { error: [{ type: 'text', text: JSON.stringify({ error: 'mismatch', loop_breaker: true, stop_retrying: true }) }] }
            : { error: [{ type: 'text', text: JSON.stringify({ error: 'mismatch' }) }] };
          yield { id: `r${i}`, type: 'tool.response', toolCallId: `c${i}`, content: JSON.stringify(payload) };
        }
        yield { id: 'e9', type: 'turn.done', state: { status: 'done' } };
      })(),
    },
  } as unknown as TrueForge;

  const events: ForgeEvent[] = [];
  const run = await new ForgeClient(options, api).start('edit', event => events.push(event));
  await assert.rejects(run.done, /Loop-Breaker stopped repeated propose_edit errors \(3x\)/);
  assert.equal(cancelledSession, 'session-loop');
  assert.ok(events.some(event => event.type === 'loop' && event.action === 'warn' && event.count === 2));
  assert.ok(events.some(event => event.type === 'loop' && event.action === 'abort' && event.count === 3));
});

test('configures adaptive compaction trigger and dynamic subagents and surfaces subagent thread events', async () => {
  let capturedSpec: any;
  const api = {
    sessions: {
      create: async (input: any) => { capturedSpec = input.agent.spec; return { data: { id: 'session-sub' } }; },
      createTurnStream: async () => (async function* () {
        yield { id: 'e1', type: 'turn.created', turnId: 't1' };
        yield { id: 'e2', type: 'thread.created', threadId: 'sub-1', title: 'Inspect CLI tests' };
        yield { id: 'e3', type: 'thread.done', threadId: 'sub-1', title: 'Inspect CLI tests', state: { status: 'done' } };
        yield { id: 'e4', type: 'turn.done', state: { status: 'done' } };
      })(),
    },
  } as unknown as TrueForge;

  const events: ForgeEvent[] = [];
  const run = await new ForgeClient({
    ...options,
    enableSubagents: true,
    compactionTriggerTokens: 10649,
  }, api).start('multi-file task', event => events.push(event));
  await run.done;

  assert.equal(capturedSpec.config.dynamicSubAgents.enabled, true);
  assert.deepEqual(capturedSpec.config.contextManagement.compaction, {
    enabled: true,
    trigger: { type: 'input_tokens', value: 10649 },
  });
  assert.ok(events.some(event => event.type === 'subagent' && event.phase === 'started' && event.title === 'Inspect CLI tests'));
  assert.ok(events.some(event => event.type === 'subagent' && event.phase === 'finished' && event.title === 'Inspect CLI tests'));
});

test('emits live model.message usage metrics and authoritative turn.done metrics', async () => {
  const api = {
    sessions: {
      create: async () => ({ data: { id: 'session-metrics' } }),
      createTurnStream: async () => (async function* () {
        yield { id: 'e1', type: 'turn.created', turnId: 't1' };
        yield {
          id: 'm1', type: 'model.message', threadId: 'main',
          usage: { inputTokens: 1200, outputTokens: 150, cacheReadTokens: 600 },
        };
        yield {
          id: 'e2', type: 'turn.done',
          state: {
            status: 'done',
            metrics: {
              totalInputTokens: 2500,
              totalOutputTokens: 320,
              totalCacheReadTokens: 1500,
              totalTokens: 2820,
              totalCostInUsd: 0.0012,
            },
          },
        };
      })(),
    },
  } as unknown as TrueForge;

  const events: ForgeEvent[] = [];
  const run = await new ForgeClient(options, api).start('telemetry check', event => events.push(event));
  await run.done;

  const metricEvents = events.filter(event => event.type === 'metrics');
  assert.equal(metricEvents.length, 2);
  assert.deepEqual(metricEvents[0].metrics, { inputTokens: 1200, outputTokens: 150, cacheReadTokens: 600, totalTokens: 1350 });
  assert.deepEqual(metricEvents[1].metrics, { inputTokens: 2500, outputTokens: 320, cacheReadTokens: 1500, totalTokens: 2820, costUsd: 0.0012 });
});

test('registers any cloud API provider (well-known OpenAI or custom OpenRouter) inside TrueForge', async () => {
  const saved: any[] = [];
  const api = {
    settings: {
      modelProviders: {
        list: async () => ({ data: [] }),
        createOrUpdate: async (req: any) => { saved.push(req.manifest); return { data: req }; },
      },
    },
  } as unknown as TrueForge;

  const openaiModel = await registerModelProvider(options.baseUrl, {
    providerType: 'openai',
    modelId: 'gpt-4o-mini',
    apiKey: 'sk-test-key',
    contextLength: 128000,
  }, api);
  assert.equal(openaiModel, 'openai/gpt-4o-mini');
  assert.equal(saved[0].type, 'openai');
  assert.deepEqual(saved[0].auth, { apiKey: 'sk-test-key' });

  const openrouterModel = await registerModelProvider(options.baseUrl, {
    providerType: 'custom',
    providerName: 'openrouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    modelId: 'anthropic/claude-3.5-sonnet',
    apiKey: 'or-test-key',
    contextLength: 200000,
  }, api);
  assert.equal(openrouterModel, 'openrouter/anthropic-claude-3-5-sonnet');
  assert.equal(saved[1].type, 'custom');
  assert.equal(saved[1].baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(saved[1].auth, { apiKey: 'or-test-key' });
});
