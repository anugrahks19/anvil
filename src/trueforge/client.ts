import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import agentDefinition from '../../agent/anvil-agent.json';

export const DEFAULT_AGENT_INSTRUCTIONS = agentDefinition.instructions;

export interface ForgeMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type ForgeEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; args?: string; isError?: boolean; deferred?: boolean }
  | { type: 'loop'; tool: string; count: number; action: 'warn' | 'abort' }
  | { type: 'compaction'; phase: 'started' | 'finished' }
  | { type: 'subagent'; phase: 'started' | 'finished'; threadId: string; title: string }
  | { type: 'metrics'; metrics: ForgeMetrics }
  | { type: 'approval'; toolCallId: string; name: string; args?: string }
  | { type: 'status'; status: string }
  | { type: 'error'; message: string }
  | { type: 'done'; status: string; metrics?: ForgeMetrics };

export interface ForgeClientOptions {
  baseUrl: string;
  modelName: string;
  mcpServerName: string;
  instructions?: string;
  enableSubagents?: boolean;
  compactionTriggerTokens?: number;
}

export interface ForgeRun {
  sessionId: string;
  done: Promise<void>;
}

type EventCallback = (event: ForgeEvent) => void;

interface PendingApproval {
  threadId: string;
  name: string;
  args?: string;
}

interface ToolCall {
  toolInfo?: { name?: string };
  function?: { arguments?: string };
}

export class ForgeClient {
  private readonly api: TrueForge;
  private readonly options: ForgeClientOptions;
  private sessionId?: string;
  private turnId?: string;
  private lastEventId?: string;
  private onEvent?: EventCallback;
  private resolveDone?: () => void;
  private rejectDone?: (reason: Error) => void;
  private readonly eventIndex = new Map<string, any>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly messageUsage = new Map<string, { input: number; output: number; cache: number }>();
  private pauseReady?: Promise<void>;
  private resolvePause?: () => void;
  private resumedStream?: AsyncIterable<any>;
  private finished = false;
  private paused = false;
  private lastErrorTool?: string;
  private consecutiveToolErrors = 0;

  constructor(options: ForgeClientOptions, api?: TrueForge) {
    this.options = options;
    this.api = api ?? new TrueForge({ baseUrl: options.baseUrl, timeoutInSeconds: 600 });
  }

  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  async start(prompt: string, onEvent: EventCallback): Promise<ForgeRun> {
    if (this.sessionId && !this.finished) throw new Error('A TrueForge run is already active.');
    this.reset(onEvent);
    const done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });

    try {
      const agentSpec: any = structuredClone(agentDefinition);
      agentSpec.model.name = this.options.modelName;
      agentSpec.mcpServers[0].name = this.options.mcpServerName;
      agentSpec.instructions = this.options.instructions ?? DEFAULT_AGENT_INSTRUCTIONS;
      if (typeof this.options.enableSubagents === 'boolean') {
        agentSpec.config = {
          ...(agentSpec.config ?? {}),
          dynamicSubAgents: { enabled: this.options.enableSubagents },
        };
      }
      if (this.options.compactionTriggerTokens && this.options.compactionTriggerTokens >= 2000) {
        agentSpec.config = {
          ...(agentSpec.config ?? {}),
          contextManagement: {
            ...(agentSpec.config?.contextManagement ?? {}),
            compaction: {
              enabled: true,
              trigger: { type: 'input_tokens', value: this.options.compactionTriggerTokens },
            },
          },
        };
      }
      const { data: session } = await this.api.sessions.create({
        agent: { spec: agentSpec },
      });
      this.sessionId = session.id;
      this.emit({ type: 'status', status: 'running' });
      const stream = await this.api.sessions.createTurnStream(session.id, {
        input: [{ type: 'user.message', content: prompt }],
      });
      void this.pump(stream as AsyncIterable<any>);
      return { sessionId: session.id, done };
    } catch (error) {
      // start() did not return `done`, so rejecting it here would create an
      // unhandled promise. The caller receives the start() rejection directly.
      this.finished = true;
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.resolveDone?.();
      throw error;
    }
  }

  /** Start another TrueForge turn in the same session after a terminal error. */
  async resume(prompt: string, onEvent: EventCallback): Promise<ForgeRun> {
    if (!this.sessionId || !this.finished) {
      throw new Error('A completed TrueForge session is required to resume.');
    }
    const sessionId = this.sessionId;
    this.reset(onEvent);
    this.sessionId = sessionId;
    const done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    try {
      this.emit({ type: 'status', status: 'running' });
      const stream = await this.api.sessions.createTurnStream(sessionId, {
        input: [{ type: 'user.message', content: prompt }],
      });
      void this.pump(stream as AsyncIterable<any>);
      return { sessionId, done };
    } catch (error) {
      this.finished = true;
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.resolveDone?.();
      throw error;
    }
  }

  async approve(toolCallId: string, allow: boolean, reason?: string): Promise<void> {
    if (!this.pendingApprovals.has(toolCallId)) {
      throw new Error('This TrueForge tool approval is no longer pending.');
    }
    await this.pauseReady;
    const pending = this.pendingApprovals.get(toolCallId);
    if (!pending || !this.paused || !this.sessionId || !this.turnId) {
      throw new Error('This TrueForge tool approval is no longer pending.');
    }
    if (!this.resumedStream) {
      this.resumedStream = await this.api.sessions.subscribeToTurn(
        this.sessionId,
        this.turnId,
        { afterEventId: this.lastEventId },
        { timeoutInSeconds: 600 },
      ) as AsyncIterable<any>;
    }
    await this.api.sessions.createTurnEvents(this.sessionId, this.turnId, {
      events: [{
        type: 'user.tool_approval',
        threadId: pending.threadId,
        toolCallId,
        approval: allow ? { status: 'allow' } : { status: 'deny', reason: reason ?? 'Rejected by user' },
      }],
    } as any);
    this.pendingApprovals.delete(toolCallId);
    if (this.pendingApprovals.size === 0) {
      this.paused = false;
      this.pauseReady = new Promise<void>(resolve => { this.resolvePause = resolve; });
      this.emit({ type: 'status', status: 'running' });
      const stream = this.resumedStream;
      this.resumedStream = undefined;
      if (stream) void this.pump(stream);
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || this.finished) return;
    await this.api.sessions.cancel(this.sessionId);
  }

  private reset(onEvent: EventCallback): void {
    this.sessionId = undefined;
    this.turnId = undefined;
    this.lastEventId = undefined;
    this.onEvent = onEvent;
    this.finished = false;
    this.paused = false;
    this.lastErrorTool = undefined;
    this.consecutiveToolErrors = 0;
    this.eventIndex.clear();
    this.pendingApprovals.clear();
    this.messageUsage.clear();
    this.resumedStream = undefined;
    this.pauseReady = new Promise<void>(resolve => { this.resolvePause = resolve; });
  }

  private emit(event: ForgeEvent): void {
    this.onEvent?.(event);
  }

  private async pump(stream: AsyncIterable<any>): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.finished) return;
        this.lastEventId = event.id ?? this.lastEventId;
        if (isEventDelta(event)) {
          let base = this.eventIndex.get(event.id);
          if (!base && event.id) {
            base = { id: event.id, type: 'model.message', threadId: event.threadId ?? 'main', content: '', toolCalls: [] };
            this.eventIndex.set(event.id, base);
          }
          if (base) mergeEventDelta(base, event);
        } else if (event.id) {
          this.eventIndex.set(event.id, event);
        }
        const merged = event.id ? this.eventIndex.get(event.id) : event;
        if (merged?.type === 'model.message' && merged.id && merged.usage) {
          this.recordMessageUsage(merged.id, merged.usage);
        }
        if (event.type === 'turn.created') this.turnId = event.turnId;
        if (event.type === 'model.message.delta' && event.threadId === 'main') {
          if (event.reasoningContent) this.emit({ type: 'reasoning', text: event.reasoningContent });
          if (event.content) this.emit({ type: 'delta', text: event.content });
        }
        if (event.type === 'thread.context_compaction_started') {
          this.emit({ type: 'compaction', phase: 'started' });
        }
        if (event.type === 'thread.context_compaction_finished') {
          this.emit({ type: 'compaction', phase: 'finished' });
        }
        if (event.type === 'thread.created' && event.threadId && event.threadId !== 'main') {
          this.emit({ type: 'subagent', phase: 'started', threadId: event.threadId, title: event.title || 'Subagent' });
        }
        if (event.type === 'thread.done' && event.threadId && event.threadId !== 'main') {
          this.emit({ type: 'subagent', phase: 'finished', threadId: event.threadId, title: event.title || 'Subagent' });
        }
        if (event.type === 'tool.response') {
          const call = this.findToolCall(event.toolCallId);
          const { name, deferred } = this.editorTool(call);
          const parsed = this.parseToolResponse(event.content);
          const isError = parsed.isError;
          this.emit({ type: 'tool', name, args: event.content, isError, deferred });
          if (isError) {
            if (this.lastErrorTool === name) this.consecutiveToolErrors++;
            else {
              this.lastErrorTool = name;
              this.consecutiveToolErrors = 1;
            }
            if (this.consecutiveToolErrors === 2) {
              this.emit({ type: 'loop', tool: name, count: 2, action: 'warn' });
            } else if (this.consecutiveToolErrors >= 4 || (this.consecutiveToolErrors >= 3 && parsed.loopBreaker)) {
              const count = this.consecutiveToolErrors;
              this.emit({ type: 'loop', tool: name, count, action: 'abort' });
              if (this.sessionId) void this.api.sessions.cancel(this.sessionId).catch(() => {});
              this.fail(new Error(`Loop-Breaker stopped repeated ${name} errors (${count}x)`));
              return;
            }
          } else {
            this.lastErrorTool = undefined;
            this.consecutiveToolErrors = 0;
          }
        }
        if (event.type === 'tool.approval_required') this.captureApprovals(event);
        if (event.type === 'turn.update' && event.state?.status === 'paused') {
          this.paused = true;
          this.resolvePause?.();
          this.emit({ type: 'status', status: 'paused' });
          return;
        }
        if (event.type === 'turn.done') {
          const finalMetrics = this.extractTurnMetrics(event.state?.metrics);
          if (finalMetrics) this.emit({ type: 'metrics', metrics: finalMetrics });
          if (event.state?.status === 'error') {
            this.fail(new Error(event.state.message ?? 'TrueForge turn failed.'));
          } else {
            this.finished = true;
            this.emit({ type: 'done', status: event.state?.status ?? 'unknown', metrics: finalMetrics });
            this.resolveDone?.();
          }
          return;
        }
      }
      // TrueForge can keep a turn alive after an SSE connection closes. Reconnect
      // instead of treating a missing terminal event as a completed run.
      if (!this.finished && !this.paused && this.sessionId && this.turnId) {
        const resumed = await this.api.sessions.subscribeToTurn(
          this.sessionId,
          this.turnId,
          { afterEventId: this.lastEventId },
          { timeoutInSeconds: 600 },
        );
        await this.pump(resumed as AsyncIterable<any>);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private captureApprovals(event: any): void {
    for (const ref of event.toolCalls ?? []) {
      const source = this.eventIndex.get(ref.sourceEventId);
      const call = source?.toolCalls?.find((candidate: any) => candidate.id === ref.id);
      const { name, args } = this.editorTool(call);
      this.pendingApprovals.set(ref.id, { threadId: event.threadId ?? 'main', name, args });
      this.emit({ type: 'approval', toolCallId: ref.id, name, args });
    }
  }

  private editorTool(call?: ToolCall): { name: string; args?: string; deferred?: boolean } {
    const name = call?.toolInfo?.name ?? 'tool';
    const args = call?.function?.arguments;
    if (name === 'call_tool' && args) {
      try {
        const { mcp_server, tool_name, input } = JSON.parse(args);
        if (mcp_server === this.options.mcpServerName && typeof tool_name === 'string' && input && typeof input === 'object') {
          return { name: tool_name, args: JSON.stringify(input), deferred: true };
        }
      } catch {
        return { name, args };
      }
    }
    return { name, args };
  }

  private findToolCall(toolCallId: string): ToolCall | undefined {
    for (const event of this.eventIndex.values()) {
      if (event.type !== 'model.message') continue;
      const call = event.toolCalls?.find((candidate: any) => candidate.id === toolCallId);
      if (call) return call;
    }
    return undefined;
  }

  private parseToolResponse(content: string): { isError?: boolean; loopBreaker?: boolean } {
    try {
      let value: any = JSON.parse(content);
      let wrappedError = false;
      if (value && Array.isArray(value.error)) {
        wrappedError = true;
        const text = value.error.find((item: any) => item?.type === 'text')?.text;
        if (typeof text === 'string') {
          try { value = JSON.parse(text); } catch { return { isError: true }; }
        }
      } else if (Array.isArray(value)) {
        const text = value.find(item => item?.type === 'text')?.text;
        if (typeof text === 'string') value = JSON.parse(text);
      }
      const loopBreaker = Boolean(value?.loop_breaker || value?.stop_retrying);
      if (typeof value?.isError === 'boolean') return { isError: value.isError, loopBreaker };
      if (typeof value?.applied === 'boolean') return { isError: !value.applied, loopBreaker };
      if (wrappedError || value?.error !== undefined) return { isError: true, loopBreaker };
      return { loopBreaker };
    } catch {
      // Ordinary tool output can be plain text.
    }
    return {};
  }

  private recordMessageUsage(id: string, usage: any): void {
    const input = Number(usage.inputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    const cache = Number(usage.cacheReadTokens ?? 0);
    if (!input && !output && !cache) return;
    const prev = this.messageUsage.get(id);
    if (prev && prev.input === input && prev.output === output && prev.cache === cache) return;
    this.messageUsage.set(id, { input, output, cache });
    let totalIn = 0;
    let totalOut = 0;
    let totalCache = 0;
    for (const item of this.messageUsage.values()) {
      totalIn += item.input;
      totalOut += item.output;
      totalCache += item.cache;
    }
    this.emit({
      type: 'metrics',
      metrics: {
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadTokens: totalCache,
        totalTokens: totalIn + totalOut,
      },
    });
  }

  private extractTurnMetrics(raw: any): ForgeMetrics | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const metrics: ForgeMetrics = {};
    if (typeof raw.totalInputTokens === 'number') metrics.inputTokens = raw.totalInputTokens;
    if (typeof raw.totalOutputTokens === 'number') metrics.outputTokens = raw.totalOutputTokens;
    if (typeof raw.totalCacheReadTokens === 'number') metrics.cacheReadTokens = raw.totalCacheReadTokens;
    if (typeof raw.totalTokens === 'number') metrics.totalTokens = raw.totalTokens;
    if (typeof raw.totalCostInUsd === 'number') metrics.costUsd = raw.totalCostInUsd;
    return Object.keys(metrics).length ? metrics : undefined;
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const problem = error instanceof Error ? error : new Error(String(error));
    this.emit({ type: 'error', message: problem.message });
    this.rejectDone?.(problem);
  }
}

export interface TrueForgeModelInfo {
  fullName: string;
  contextLength?: number;
}

export type WellKnownProviderType =
  | 'openai'
  | 'anthropic'
  | 'google-gemini'
  | 'fireworks'
  | 'together'
  | 'moonshot'
  | 'alibaba'
  | 'zai';

export interface ProviderRegistrationInput {
  providerType: WellKnownProviderType | 'custom';
  providerName?: string;
  endpointUrl?: string;
  modelId: string;
  apiKey?: string;
  contextLength?: number;
}

export interface LocalProviderInput {
  providerName: string;
  endpointUrl: string;
  modelId: string;
  apiKey?: string;
  contextLength?: number;
}

export function sanitizeResourceName(raw: string, fallback = 'local-model'): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback;
}

export async function listTrueForgeModels(baseUrl: string, api?: TrueForge): Promise<TrueForgeModelInfo[]> {
  const client = api ?? new TrueForge({ baseUrl, timeoutInSeconds: 10 });
  const response = await client.settings.modelProviders.list();
  const models: TrueForgeModelInfo[] = [];
  for (const provider of response.data ?? []) {
    for (const model of provider.manifest?.models ?? []) {
      models.push({
        fullName: `${provider.name}/${model.name}`,
        contextLength: model.properties?.contextLength,
      });
    }
  }
  return models;
}

export async function registerModelProvider(
  baseUrl: string,
  input: ProviderRegistrationInput,
  api?: TrueForge,
): Promise<string> {
  const client = api ?? new TrueForge({ baseUrl, timeoutInSeconds: 15 });
  const isCustom = input.providerType === 'custom';
  const providerName = isCustom
    ? sanitizeResourceName(input.providerName || 'custom-api', 'custom-api')
    : input.providerType;
  const modelName = sanitizeResourceName(input.modelId, 'model');
  const existingProviders = await client.settings.modelProviders.list().catch(() => ({ data: [] }));
  const existing = existingProviders.data?.find(provider => provider.name === providerName);
  const existingManifest: any = existing?.manifest;
  const sameEndpoint = !isCustom || existingManifest?.baseUrl === input.endpointUrl?.trim();
  const priorModels = sameEndpoint
    ? (existingManifest?.models ?? []).filter((model: any) => model.name !== modelName)
    : [];
  const nextModel = {
    modelId: input.modelId.trim(),
    name: modelName,
    properties: input.contextLength ? { contextLength: input.contextLength } : {},
  };
  const trimmedKey = input.apiKey?.trim();
  const existingAuth = existingManifest?.auth;
  const auth = trimmedKey ? { apiKey: trimmedKey } : existingAuth;

  if (isCustom) {
    if (!input.endpointUrl?.trim()) throw new Error('Endpoint URL is required for custom OpenAI-compatible APIs.');
    await client.settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'custom',
        name: providerName,
        baseUrl: input.endpointUrl.trim(),
        ...(auth ? { auth } : {}),
        models: [...priorModels, nextModel],
      },
    });
  } else {
    if (!auth) throw new Error(`An API key is required for ${providerName}.`);
    await client.settings.modelProviders.createOrUpdate({
      manifest: {
        type: input.providerType,
        auth,
        ...(input.endpointUrl?.trim() ? { baseUrl: input.endpointUrl.trim() } : {}),
        models: [...priorModels, nextModel],
      } as any,
    });
  }
  return `${providerName}/${modelName}`;
}

export async function registerCustomModelProvider(
  baseUrl: string,
  input: LocalProviderInput,
  api?: TrueForge,
): Promise<string> {
  return registerModelProvider(baseUrl, {
    providerType: 'custom',
    providerName: input.providerName,
    endpointUrl: input.endpointUrl,
    modelId: input.modelId,
    apiKey: input.apiKey,
    contextLength: input.contextLength,
  }, api);
}
