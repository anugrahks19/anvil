import * as path from 'node:path';
import * as vscode from 'vscode';
import { assembleContext } from './context/assembly';
import { EditorBridge } from './mcp/editorBridge';
import { analyzeProposalFile, checkBufferSyntax, type DiagnosticIssue, type FileDiagnostics } from './review/analysis';
import type { Proposal } from './review/proposalStore';
import { verifySelectedHunks, workspacePython } from './review/verification';
import { ForgeClient, type ForgeEvent, listTrueForgeModels, registerModelProvider, type WellKnownProviderType } from './trueforge/client';
import { ForgePanel, type PanelAction, type ReviewView, type TelemetryState } from './ui/panel';

let bridge: EditorBridge | undefined;
let activeClient: ForgeClient | undefined;
let activeRun = 0;

interface PendingReview {
  toolCallId: string;
  proposalId: string;
  approvalSent: boolean;
}

class PreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();

  put(key: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'anvil-preview', path: `/${key}` });
    this.content.set(uri.toString(), text);
    while (this.content.size > 40) {
      const oldest = this.content.keys().next().value;
      if (oldest) this.content.delete(oldest);
    }
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? '';
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = new ForgePanel(context.extensionUri);
  const preview = new PreviewProvider();
  let latestProposal: Proposal | undefined;
  let pendingReview: PendingReview | undefined;
  let bridgeReady = false;
  let running = false;
  let cancelling = false;
  let appliedInRun = false;
  let applyRequestedInRun = false;
  let retryAbort: AbortController | undefined;
  let verificationAbort: AbortController | undefined;
  let runStartedAt = 0;
  let reasoningBuffer = '';
  let telemetry: TelemetryState | undefined;
  const modelContextLengths = new Map<string, number>();
  const contextLocations = new Map<string, number | undefined>();
  let selectedModel = configuredModels()[0] ?? '';

  const pushTelemetry = () => {
    if (!telemetry) return;
    if (runStartedAt > 0) telemetry.elapsedMs = Date.now() - runStartedAt;
    panel.setTelemetry(telemetry);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ForgePanel.viewType, panel),
    vscode.workspace.registerTextDocumentContentProvider('anvil-preview', preview),
    panel.onAction(action => { void handlePanelAction(action); }),
    panel,
  );
  panel.setModels(configuredModels(), selectedModel);
  if (!selectedModel) panel.setStatus('Click "+ Connect API" to add a model');
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('anvil.modelProfiles') && !event.affectsConfiguration('anvil.trueForgeUrl')) return;
    const models = configuredModels();
    if (!models.includes(selectedModel)) selectedModel = models[0] ?? '';
    panel.setModels(models, selectedModel);
    if (event.affectsConfiguration('anvil.trueForgeUrl')) void syncTrueForgeMetadata();
  }));
  void syncTrueForgeMetadata();

  if (workspaceRoot) {
    bridge = new EditorBridge(workspaceRoot);
    context.subscriptions.push(bridge.onProposal(proposal => {
      latestProposal = proposal;
      panel.addActivity(`Staged ${proposal.files.length} file${proposal.files.length === 1 ? '' : 's'} for review`);
      if (pendingReview && pendingReview.proposalId === proposal.id) panel.setReview(toReviewView(proposal));
    }));
    context.subscriptions.push(bridge.onApplied(({ proposalId, files }) => {
      if (files.length) appliedInRun = true;
      panel.setApplying(false);
      panel.setCanUndo(Boolean(bridge?.canUndo));
      panel.addActivity(`Applied reviewed hunks in ${files.length} file${files.length === 1 ? '' : 's'}`);
      if (pendingReview?.proposalId === proposalId) {
        pendingReview = undefined;
        latestProposal = undefined;
        panel.setReview(undefined);
        panel.setStatus('Reviewed change applied');
      }
    }));
    context.subscriptions.push(bridge.onApplyFailed(({ proposalId, message }) => {
      panel.setApplying(false);
      if (pendingReview?.proposalId === proposalId) {
        pendingReview.approvalSent = false;
        panel.setStatus(`Apply failed: ${message}`);
        panel.addActivity('The diff remains visible for inspection; start a new run to revise it.');
      }
    }));
    context.subscriptions.push(bridge.onCompressed(({ tool, savedTokens, detail }) => {
      if (telemetry) {
        telemetry.savedTokens += savedTokens;
        pushTelemetry();
      }
      panel.addActivity(`Tool compression: deduplicated ${tool}(${detail}) (~${savedTokens} tokens saved)`);
    }));
    context.subscriptions.push(bridge.onLoop(({ tool, target, count, tripped }) => {
      panel.addActivity(
        tripped
          ? `Loop-Breaker tripped: ${tool} failed ${count}x on ${target}`
          : `Loop-Breaker: injected recovery hint after ${count}x ${tool} errors on ${target}`,
      );
    }));
    try {
      const port = vscode.workspace.getConfiguration('anvil').get<number>('mcpPort', 39281);
      await bridge.start(port);
      bridgeReady = true;
      panel.addActivity(`Editor MCP bridge listening on 127.0.0.1:${port}`);
    } catch (error) {
      const message = errorMessage(error);
      panel.setStatus(`MCP bridge failed: ${message}`);
      void vscode.window.showErrorMessage(`Anvil could not start its editor bridge: ${message}`);
    }
  } else {
    panel.setStatus('Open a workspace folder to begin');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('anvil.openPanel', () => panel.show()),
    vscode.commands.registerCommand('anvil.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Select the code to edit, then run Anvil: Inline Edit.');
        return;
      }
      if (editor.document.isDirty) {
        void vscode.window.showInformationMessage('Save the selected file before requesting an inline edit.');
        return;
      }
      const instruction = await vscode.window.showInputBox({
        title: 'Anvil: Inline Edit',
        prompt: 'What should change in the selected code?',
        placeHolder: 'Describe the edit in plain language',
        ignoreFocusOut: true,
      });
      if (!instruction?.trim()) return;
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      const selection = editor.document.getText(editor.selection);
      const prompt = `Inline edit request. The user selected lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1} in @${relativePath}.\nInstruction: ${instruction.trim()}\nKeep the change scoped to that selected function or region. Use the editor MCP tools to inspect the source, stage a proposed edit, and request review before applying it.`;
      panel.show();
      await runPrompt(prompt, relativePath, selection);
    }),
    vscode.commands.registerCommand('anvil.undoLastApply', async () => {
      await undo();
    }),
    vscode.commands.registerCommand('anvil.connectApi', async () => {
      await connectApiModel(false);
    }),
    vscode.commands.registerCommand('anvil.connectLocalModel', async () => {
      await connectApiModel(true);
    }),
  );

  context.subscriptions.push({ dispose: () => {
    activeRun++;
    verificationAbort?.abort();
    void activeClient?.cancel();
    void bridge?.stop();
  } });

  async function handlePanelAction(action: PanelAction): Promise<void> {
    switch (action.type) {
      case 'submit':
        await runPrompt(action.prompt);
        break;
      case 'cancel':
        await cancel();
        break;
      case 'approve':
        if (verificationAbort || !pendingReview || pendingReview.approvalSent || action.proposalId !== pendingReview.proposalId) return;
        try {
          bridge?.setSelectedHunks(action.proposalId, action.selectedHunkIds);
          panel.setStatus('Applying selected hunks');
          panel.setApplying(true);
          pendingReview.approvalSent = true;
          applyRequestedInRun = true;
          await activeClient?.approve(pendingReview.toolCallId, true);
        } catch (error) {
          if (pendingReview && action.proposalId === pendingReview.proposalId) {
            pendingReview.approvalSent = false;
          }
          applyRequestedInRun = false;
          panel.setApplying(false);
          panel.setStatus(`Apply status uncertain: ${errorMessage(error)}`);
          panel.addActivity(`Approval error: ${errorMessage(error)}`);
        }
        break;
      case 'verify':
        await verifyReview(action.proposalId, action.selectedHunkIds);
        break;
      case 'cancelVerify':
        verificationAbort?.abort();
        break;
      case 'reject':
        if (verificationAbort || !pendingReview || pendingReview.approvalSent || action.proposalId !== pendingReview.proposalId) return;
        try {
          pendingReview.approvalSent = true;
          panel.setApplying(true);
          await activeClient?.approve(pendingReview.toolCallId, false, 'The user rejected the proposed change.');
          bridge?.discardAll();
          pendingReview = undefined;
          panel.setReview(undefined);
          panel.setApplying(false);
          panel.setStatus('Rejected');
        } catch (error) {
          if (pendingReview && action.proposalId === pendingReview.proposalId) {
            pendingReview.approvalSent = false;
          }
          panel.setApplying(false);
          panel.setStatus(`Reject failed: ${errorMessage(error)}`);
          panel.addActivity(`Reject error: ${errorMessage(error)}`);
        }
        break;
      case 'preview':
        await showPreview(action.proposalId, action.path);
        break;
      case 'openContext': {
        if (!workspaceRoot || !contextLocations.has(action.path)) return;
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspaceRoot, action.path)));
          const line = Math.min(document.lineCount - 1, (contextLocations.get(action.path) ?? 1) - 1);
          const selection = new vscode.Range(line, 0, line, 0);
          await vscode.window.showTextDocument(document, { selection, preview: true });
        } catch (error) {
          panel.addActivity(`Could not open context: ${errorMessage(error)}`);
        }
        break;
      }
      case 'undo':
        await undo();
        break;
      case 'model':
        if (running || cancelling) {
          panel.setStatus('Cancel the current run before switching models');
          panel.setModels(configuredModels(), selectedModel);
          return;
        }
        if (!configuredModels().includes(action.modelName)) return;
        selectedModel = action.modelName;
        panel.setModels(configuredModels(), selectedModel);
        panel.addActivity(`Selected model: ${selectedModel}`);
        break;
      case 'connectApi':
        await connectApiModel(false);
        break;
      case 'pickModels':
        await manageModelProfiles();
        break;
      case 'openSession': {
        const base = vscode.workspace.getConfiguration('anvil').get<string>('trueForgeUrl', 'http://localhost:8790').replace(/\/+$/, '');
        const uri = vscode.Uri.parse(`${base}/sessions/${encodeURIComponent(action.sessionId)}`);
        await vscode.env.openExternal(uri);
        break;
      }
    }
  }

  async function verifyReview(proposalId: string, ids: string[]): Promise<void> {
    if (!workspaceRoot || !bridge || verificationAbort || pendingReview?.proposalId !== proposalId || pendingReview.approvalSent) return;
    const controller = new AbortController();
    verificationAbort = controller;
    const selection = JSON.stringify([...ids].sort());
    try {
      const patches = bridge.previewSelectedHunks(proposalId, ids);
      if (!patches.length) throw new Error('Select at least one changed hunk to verify');
      const target = await vscode.window.showInputBox({
        title: 'Verify selected hunks with pytest',
        prompt: 'Run this Python test against a temporary copy of the tracked workspace',
        placeHolder: 'tests/test_cli.py',
        value: patches.find(file => /(?:^|\/)test_[^/]+\.py$/.test(file.path))?.path,
      });
      if (!target?.trim()) return;
      controller.signal.throwIfAborted();
      if (pendingReview?.proposalId !== proposalId) return;
      const python = await workspacePython(workspaceRoot);
      const confirmed = await vscode.window.showWarningMessage(
        `Run pytest on ${target.trim()} with ${python}?`,
        { modal: true, detail: 'Tests execute local code with your user permissions. Anvil applies the selected hunks to a temporary tracked-file copy for this check.' }, 'Run pytest',
      );
      if (confirmed !== 'Run pytest' || pendingReview?.proposalId !== proposalId) return;
      panel.setVerification({ proposalId, selection, status: 'running', message: `Running ${target.trim()} in a temporary copy…` });
      const result = await verifySelectedHunks(workspaceRoot, patches, python, target.trim(), controller.signal);
      if (pendingReview?.proposalId !== proposalId) return;
      const label = result.passed ? 'Passed' : 'Failed';
      panel.setVerification({ proposalId, selection, status: result.passed ? 'passed' : 'failed', message: `${label} · ${target.trim()}\n${result.output}` });
    } catch (error) {
      if (pendingReview?.proposalId === proposalId) {
        if (controller.signal.aborted) panel.setVerification(undefined);
        else panel.setVerification({ proposalId, selection, status: 'failed', message: errorMessage(error) });
      }
    } finally {
      verificationAbort = undefined;
    }
  }

  async function runPrompt(prompt: string, activeFile?: string, selection?: string): Promise<void> {
    if (!workspaceRoot || !bridge || !bridgeReady) {
      void vscode.window.showErrorMessage('Open a workspace folder and restart Anvil.');
      return;
    }
    if (running || cancelling) {
      panel.setStatus('Cancel the current run before sending another request');
      return;
    }
    if (!selectedModel) {
      panel.setStatus('Configure a model name in anvil.modelProfiles');
      void vscode.window.showInformationMessage('Configure a model in TrueForge, then add its full name to Anvil: Model Profiles.');
      return;
    }
    if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file')) {
      panel.setStatus('Save open files before starting an agent run');
      return;
    }
    const runId = ++activeRun;
    running = true;
    cancelling = false;
    latestProposal = undefined;
    pendingReview = undefined;
    appliedInRun = false;
    applyRequestedInRun = false;
    bridge.discardAll();
    contextLocations.clear();
    panel.resetRun();
    runStartedAt = Date.now();
    reasoningBuffer = '';
    telemetry = {
      turns: 0,
      toolCalls: 0,
      savedTokens: 0,
      contextUsedTokens: 0,
      contextBudgetTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      isLocal: isLocalModelProfile(selectedModel),
      elapsedMs: 0,
    };
    pushTelemetry();
    panel.setRunState(true, false);
    panel.setStatus('Selecting context');
    try {
      const budgetTokens = resolveContextBudget(selectedModel, modelContextLengths.get(selectedModel));
      const assembled = await assembleContext(workspaceRoot, prompt, {
        budgetTokens,
        activeFile,
        selection,
      });
      if (runId !== activeRun) return;
      for (const selected of assembled.selections) contextLocations.set(selected.path, selected.line);
      panel.setContext(assembled.selections, assembled.usedTokens, assembled.budgetTokens);
      if (telemetry) {
        telemetry.contextUsedTokens = assembled.usedTokens;
        telemetry.contextBudgetTokens = assembled.budgetTokens;
        pushTelemetry();
      }
      const fullPrompt = `${prompt}\n\nRepository context selected by the extension (verify against MCP tools before editing):\n${assembled.text}`;
      const profiles = configuredModels();
      const candidates = [selectedModel, ...profiles.filter(model => model !== selectedModel)];
      const isInline = Boolean(activeFile && selection);
      const allowSubagents = !isInline && vscode.workspace.getConfiguration('anvil').get<boolean>('enableSubagents', true);
      await launch(candidates, 0, 0, fullPrompt, runId, allowSubagents);
    } catch (error) {
      if (runId !== activeRun) return;
      running = false;
      panel.setRunState(false, false);
      panel.setStatus(`Failed: ${errorMessage(error)}`);
      panel.addActivity(`Error: ${errorMessage(error)}`);
    }
  }

  async function launch(
    models: string[],
    modelIndex: number,
    retry: number,
    prompt: string,
    runId: number,
    allowSubagents: boolean,
    existingClient?: ForgeClient,
  ): Promise<void> {
    if (runId !== activeRun) return;
    const modelName = models[modelIndex];
    const compactionTriggerTokens = resolveCompactionTrigger(modelContextLengths.get(modelName));
    const effectiveSubagents = allowSubagents && !isLocalModelProfile(modelName);
    const client = existingClient ?? new ForgeClient({
      baseUrl: vscode.workspace.getConfiguration('anvil').get<string>('trueForgeUrl', 'http://localhost:8790'),
      modelName,
      mcpServerName: vscode.workspace.getConfiguration('anvil').get<string>('mcpServerName', 'anvil-editor'),
      enableSubagents: effectiveSubagents,
      compactionTriggerTokens,
    });
    if (!existingClient) {
      panel.addActivity(
        `TrueForge harness: compaction @ ${compactionTriggerTokens.toLocaleString()} tok · deferred tools · subagents ${effectiveSubagents ? 'on' : 'off'}`,
      );
    }
    if (telemetry) {
      telemetry.turns += 1;
      telemetry.isLocal = isLocalModelProfile(modelName);
      pushTelemetry();
    }
    activeClient = client;
    let failureHandled = false;
    const onFailure = async (message: string): Promise<void> => {
      if (failureHandled || runId !== activeRun) return;
      failureHandled = true;
      if (appliedInRun || applyRequestedInRun) {
        running = false;
        panel.setRunState(false, false);
        panel.setStatus(`Model failed after apply approval: ${message}`);
        panel.addActivity('The request was not replayed because it may have already changed files.');
        return;
      }
      const nonRetryable = /\b(?:401|403|404)\b|invalid.?key|api.?key.?(?:invalid|not valid)|model.{0,40}not found|unauthori[sz]ed|authentication|permission denied/i.test(message);
      const loopBroken = /loop-breaker/i.test(message);
      const rateLimited = /\b429\b|rate.?limit|quota/i.test(message);
      const canResume = rateLimited && Boolean(client.activeSessionId);
      if (!canResume) {
        try { bridge?.discardAll(); }
        catch (error) { panel.addActivity(`Waiting for an approved edit to finish: ${errorMessage(error)}`); }
        latestProposal = undefined;
        pendingReview = undefined;
        panel.setReview(undefined);
      }
      const providerDelay = /(?:retry in|retryDelay["':\s]+)\s*(\d+(?:\.\d+)?)\s*s/i.exec(message);
      const requestedMs = providerDelay ? Math.ceil(Number(providerDelay[1]) * 1000) + 1000 : undefined;
      if (!nonRetryable && !loopBroken && retry < 2 && (requestedMs ?? 0) <= 120_000) {
        const delay = requestedMs ?? (rateLimited ? 60_000 : retry === 0 ? 500 : 1500);
        panel.addActivity(`Model error; retrying ${modelName} in ${delay} ms (${message})`);
        panel.setStatus('Retrying model');
        const slept = await waitWithCancel(delay);
        if (!slept || runId !== activeRun) return;
        if (canResume) {
          panel.addActivity(`Resuming TrueForge session ${client.activeSessionId} after rate limit`);
          await launch(models, modelIndex, retry + 1, prompt, runId, allowSubagents, client);
        } else {
          panel.clearStream();
          await launch(models, modelIndex, retry + 1, prompt, runId, allowSubagents);
        }
      } else if (modelIndex + 1 < models.length) {
        try { bridge?.discardAll(); }
        catch (error) { panel.addActivity(`Waiting for an approved edit to finish: ${errorMessage(error)}`); }
        latestProposal = undefined;
        pendingReview = undefined;
        panel.setReview(undefined);
        const nextModel = models[modelIndex + 1];
        const fromLocal = isLocalModelProfile(modelName);
        const toLocal = isLocalModelProfile(nextModel);
        const modeLabel = fromLocal !== toLocal
          ? (toLocal ? 'Hybrid Cloud → Local fallback' : 'Hybrid Local → Cloud fallback')
          : 'Automatic fallback';
        panel.addActivity(`${modeLabel}: switching from ${modelName} to ${nextModel}`);
        panel.setStatus(toLocal ? 'Switching to local model' : 'Switching model');
        panel.clearStream();
        await launch(models, modelIndex + 1, 0, prompt, runId, allowSubagents);
      } else {
        running = false;
        panel.setRunState(false, false);
        panel.addActivity(`Model failure: ${message}`);
        panel.setStatus('Model failed');
      }
    };
    panel.setStatus(existingClient ? `Resuming: ${modelName}` : `Connecting: ${modelName}`);
    try {
      const onEvent = (event: ForgeEvent) => {
        if (runId !== activeRun || client !== activeClient) return;
        void handleForgeEvent(event, client, onFailure).catch(error => {
          if (runId === activeRun && client === activeClient) {
            panel.setStatus(`Editor action failed: ${errorMessage(error)}`);
            panel.addActivity(`Editor action failed: ${errorMessage(error)}`);
          }
        });
      };
      const run = existingClient
        ? await client.resume('Continue the original request from the prior turn. Keep any staged proposals and finish any missing edits before calling apply_reviewed_proposal.', onEvent)
        : await client.start(prompt, onEvent);
      if (runId !== activeRun) {
        await client.cancel();
        return;
      }
      panel.setSession(run.sessionId);
      void run.done.catch(error => { void onFailure(errorMessage(error)); });
    } catch (error) {
      await onFailure(errorMessage(error));
    }
  }

  function waitWithCancel(delayMs: number): Promise<boolean> {
    retryAbort?.abort();
    const controller = new AbortController();
    retryAbort = controller;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (retryAbort === controller) retryAbort = undefined;
        resolve(true);
      }, delayMs);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        if (retryAbort === controller) retryAbort = undefined;
        resolve(false);
      }, { once: true });
    });
  }

  async function handleForgeEvent(event: ForgeEvent, client: ForgeClient, onFailure: (message: string) => Promise<void>): Promise<void> {
    switch (event.type) {
      case 'delta':
        panel.setReasoningSnippet('');
        panel.appendStream(event.text);
        break;
      case 'reasoning':
        reasoningBuffer = (reasoningBuffer + event.text).slice(-240);
        const latestLine = reasoningBuffer.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? '';
        if (latestLine) panel.setReasoningSnippet(latestLine.slice(-110));
        break;
      case 'tool':
        if (telemetry) {
          telemetry.toolCalls += 1;
          pushTelemetry();
        }
        panel.addActivity(`Tool: ${event.name}${event.deferred ? ' (deferred)' : ''}${event.isError ? ' (error)' : ''}`);
        break;
      case 'metrics':
        if (telemetry) {
          if (typeof event.metrics.inputTokens === 'number') telemetry.inputTokens = event.metrics.inputTokens;
          if (typeof event.metrics.outputTokens === 'number') telemetry.outputTokens = event.metrics.outputTokens;
          if (typeof event.metrics.cacheReadTokens === 'number') telemetry.cacheReadTokens = event.metrics.cacheReadTokens;
          if (typeof event.metrics.costUsd === 'number') telemetry.costUsd = event.metrics.costUsd;
          pushTelemetry();
        }
        break;
      case 'loop':
        panel.addActivity(
          event.action === 'abort'
            ? `Loop-Breaker stopped stuck ${event.tool} loop (${event.count} consecutive errors)`
            : `Loop-Breaker warning: ${event.tool} failed ${event.count} times in a row`,
        );
        break;
      case 'compaction':
      case 'subagent':
        panel.recordHarnessEvent(event);
        break;
      case 'status':
        if (event.status === 'running') panel.setStatus('Running');
        break;
      case 'approval':
        if (event.name.endsWith('apply_reviewed_proposal')) {
          const proposalId = proposalIdFromArgs(event.args) ?? latestProposal?.id;
          const proposal = proposalId ? bridge?.getProposal(proposalId) : undefined;
          if (!proposal) {
            await client.approve(event.toolCallId, false, 'No staged proposal exists.');
            return;
          }
          pendingReview = { toolCallId: event.toolCallId, proposalId: proposal.id, approvalSent: false };
          panel.setReview(toReviewView(proposal));
          panel.setStatus('Review hunks');
          await showPreview(proposal.id, proposal.files[0]?.path);
          void runPreApplyDiagnostics(proposal);
        } else if (event.name.endsWith('run_command')) {
          const command = commandFromArgs(event.args);
          if (!command) {
            await client.approve(event.toolCallId, false, 'Could not verify the command arguments.');
            return;
          }
          const decision = await vscode.window.showWarningMessage(
            `Allow the agent to run this command?\n${command}`,
            { modal: true },
            'Allow', 'Deny',
          );
          if (client !== activeClient || !running) return;
          if (decision === 'Allow') bridge?.approveCommand(command);
          try {
            await client.approve(event.toolCallId, decision === 'Allow', 'Command rejected by user.');
          } catch (error) {
            bridge?.revokeCommand();
            panel.setStatus(`Command approval failed: ${errorMessage(error)}`);
          }
        } else {
          const decision = await vscode.window.showWarningMessage(`Allow TrueForge tool ${event.name}?`, { modal: true }, 'Allow', 'Deny');
          await client.approve(event.toolCallId, decision === 'Allow');
        }
        break;
      case 'done':
        running = false;
        pushTelemetry();
        panel.setRunState(false, false);
        panel.setStatus(event.status === 'done' ? 'Completed' : `Stopped: ${event.status}`);
        if (latestProposal && event.status === 'done' && !pendingReview) {
          panel.addActivity('A staged proposal remains; no change was applied without review.');
        }
        break;
      case 'error':
        await onFailure(event.message);
        break;
    }
  }

  async function cancel(): Promise<void> {
    verificationAbort?.abort();
    if (!running || cancelling) return;
    activeRun++;
    running = false;
    cancelling = true;
    retryAbort?.abort();
    panel.setRunState(false, true);
    panel.setStatus('Cancelling');
    try { bridge?.discardAll(); }
    catch (error) { panel.addActivity(`An approved edit is finishing: ${errorMessage(error)}`); }
    latestProposal = undefined;
    pendingReview = undefined;
    panel.setReview(undefined);
    const clientToCancel = activeClient;
    activeClient = undefined;
    try {
      await clientToCancel?.cancel();
      pushTelemetry();
      panel.setStatus('Cancelled; unapproved edits discarded');
    } catch (error) {
      panel.setStatus(`Cancellation error: ${errorMessage(error)}`);
    } finally {
      cancelling = false;
      panel.setRunState(false, false);
    }
  }

  async function undo(): Promise<void> {
    if (!bridge || running || cancelling) return;
    try {
      const undone = await bridge.undoLastApply();
      panel.setCanUndo(bridge.canUndo);
      panel.setStatus(undone ? 'Last agent apply undone' : 'Nothing safe to undo');
      if (undone) panel.addActivity('Undid last agent apply');
    } catch (error) {
      panel.setCanUndo(bridge.canUndo);
      panel.setStatus(`Undo failed: ${errorMessage(error)}`);
      panel.addActivity(`Undo failed: ${errorMessage(error)}`);
    }
  }

  async function showPreview(proposalId: string, filePath?: string): Promise<void> {
    if (!filePath) return;
    const file = bridge?.getProposal(proposalId)?.files.find(item => item.path === filePath);
    if (!file) return;
    const key = `${proposalId}/${encodeURIComponent(filePath)}`;
    const extension = path.extname(filePath);
    const before = preview.put(`${key}/before${extension}`, file.baseText);
    const after = preview.put(`${key}/after${extension}`, file.proposedText);
    await vscode.commands.executeCommand('vscode.diff', before, after, `Anvil review: ${path.basename(filePath)}`);
  }

  async function runPreApplyDiagnostics(proposal: Proposal): Promise<void> {
    if (!workspaceRoot) return;
    const results = new Map<string, FileDiagnostics>();
    await Promise.all(proposal.files.map(async file => {
      const issues: DiagnosticIssue[] = [];
      let checked = false;

      const syntax = await checkBufferSyntax(file.path, file.proposedText, workspaceRoot);
      if (syntax) {
        checked = true;
        issues.push(...syntax.issues);
      }

      try {
        const key = `${proposal.id}/${encodeURIComponent(file.path)}`;
        const extension = path.extname(file.path);
        const afterUri = preview.put(`${key}/after${extension}`, file.proposedText);
        await vscode.workspace.openTextDocument(afterUri);
        await new Promise(resolve => setTimeout(resolve, 350));
        const originalUri = vscode.Uri.file(path.join(workspaceRoot, file.path));
        const baseline = new Set(
          vscode.languages.getDiagnostics(originalUri)
            .filter(diag => diag.severity === vscode.DiagnosticSeverity.Error)
            .map(diag => diag.message),
        );
        const proposedDiags = vscode.languages.getDiagnostics(afterUri);
        if (proposedDiags.length > 0) checked = true;
        for (const diag of proposedDiags) {
          if (diag.severity !== vscode.DiagnosticSeverity.Error) continue;
          if (baseline.has(diag.message)) continue;
          const duplicate = issues.some(item => item.message === diag.message);
          if (!duplicate) {
            issues.push({
              line: diag.range.start.line + 1,
              message: diag.message,
              source: 'vscode',
            });
          }
        }
      } catch {
        // Virtual preview diagnostics are best-effort; syntax checker still applies.
      }

      results.set(file.path, {
        status: issues.length > 0 ? 'errors' : checked ? 'clean' : 'unchecked',
        newErrorCount: issues.length,
        issues,
      });
    }));

    if (pendingReview?.proposalId !== proposal.id) return;
    const latest = bridge?.getProposal(proposal.id) ?? proposal;
    panel.setReview(toReviewView(latest, results));
    const totalErrors = [...results.values()].reduce((sum, item) => sum + item.newErrorCount, 0);
    panel.addActivity(
      totalErrors > 0
        ? `Pre-apply diagnostics: ${totalErrors} new error${totalErrors === 1 ? '' : 's'} detected before apply`
        : `Pre-apply diagnostics: 0 new errors across ${latest.files.length} staged file${latest.files.length === 1 ? '' : 's'}`,
    );
  }

  async function syncTrueForgeMetadata(): Promise<void> {
    const baseUrl = vscode.workspace.getConfiguration('anvil').get<string>('trueForgeUrl', 'http://localhost:8790');
    try {
      const list = await listTrueForgeModels(baseUrl);
      modelContextLengths.clear();
      for (const item of list) {
        if (item.contextLength) modelContextLengths.set(item.fullName, item.contextLength);
      }
    } catch {
      // TrueForge may not be started yet; metadata syncs lazily on next connect/manage.
    }
  }

  async function saveModelProfiles(updated: string[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('anvil');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
      await config.update('modelProfiles', updated, target);
    } catch {
      await config.update('modelProfiles', updated, vscode.ConfigurationTarget.Global);
    }
  }

  async function manageModelProfiles(): Promise<void> {
    if (running || cancelling) {
      panel.setStatus('Cancel the current run before managing models');
      return;
    }
    const baseUrl = vscode.workspace.getConfiguration('anvil').get<string>('trueForgeUrl', 'http://localhost:8790');
    let available: Array<{ fullName: string; contextLength?: number }> = [];
    try {
      available = await listTrueForgeModels(baseUrl);
      modelContextLengths.clear();
      for (const item of available) {
        if (item.contextLength) modelContextLengths.set(item.fullName, item.contextLength);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not list TrueForge models: ${errorMessage(error)}`);
      return;
    }
    const current = configuredModels();
    const allNames = [...new Set([...current, ...available.map(item => item.fullName)])];
    if (allNames.length === 0) {
      void vscode.window.showInformationMessage('No models found in TrueForge yet. Click "+ Connect API" to add your own API key or local runtime.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      allNames.map(name => ({
        label: name,
        description: modelContextLengths.get(name) ? `ctx ${modelContextLengths.get(name)!.toLocaleString()}` : undefined,
        picked: current.includes(name),
      })),
      {
        canPickMany: true,
        title: 'Choose Active Model Profiles (Preference / Fallback Order)',
        placeHolder: 'Check only the models you want in your dropdown; uncheck others to keep it clean',
        ignoreFocusOut: true,
      },
    );
    if (!picked) return;
    const nextProfiles = picked.map(item => item.label);
    await saveModelProfiles(nextProfiles);
    if (!nextProfiles.includes(selectedModel)) selectedModel = nextProfiles[0] ?? '';
    panel.setModels(nextProfiles, selectedModel);
    panel.addActivity(`Updated active model profiles (${nextProfiles.length} selected)`);
  }

  async function connectApiModel(localOnly: boolean): Promise<void> {
    if (running || cancelling) {
      panel.setStatus('Cancel the current run before connecting a model');
      return;
    }
    interface ProviderPreset {
      label: string;
      description: string;
      providerType: WellKnownProviderType | 'custom';
      providerName: string;
      url?: string;
      sampleModel: string;
      needsKey: boolean;
      allowCustomName?: boolean;
      defaultCtx: number;
      local?: boolean;
    }
    const allPresets: ProviderPreset[] = [
      { label: 'OpenAI API', description: 'gpt-4o, gpt-5, o3-mini (Bring Your Own Key)', providerType: 'openai', providerName: 'openai', sampleModel: 'gpt-4o-mini', needsKey: true, defaultCtx: 128000 },
      { label: 'Anthropic API', description: 'Claude Sonnet / Haiku (Bring Your Own Key)', providerType: 'anthropic', providerName: 'anthropic', sampleModel: 'claude-3-5-sonnet-latest', needsKey: true, defaultCtx: 200000 },
      { label: 'Google Gemini API', description: 'Gemini Flash / Pro (Bring Your Own Key)', providerType: 'google-gemini', providerName: 'google-gemini', sampleModel: 'gemini-2.5-flash', needsKey: true, defaultCtx: 1048576 },
      { label: 'OpenRouter API', description: 'https://openrouter.ai/api/v1 (Any model via OpenRouter)', providerType: 'custom', providerName: 'openrouter', url: 'https://openrouter.ai/api/v1', sampleModel: 'anthropic/claude-3.5-sonnet', needsKey: true, defaultCtx: 128000 },
      { label: 'Groq API', description: 'https://api.groq.com/openai/v1 (Fast hosted open models)', providerType: 'custom', providerName: 'groq', url: 'https://api.groq.com/openai/v1', sampleModel: 'llama-3.3-70b-versatile', needsKey: true, defaultCtx: 128000 },
      { label: 'DeepSeek API', description: 'https://api.deepseek.com/v1', providerType: 'custom', providerName: 'deepseek', url: 'https://api.deepseek.com/v1', sampleModel: 'deepseek-chat', needsKey: true, defaultCtx: 65536 },
      { label: 'NVIDIA NIM API', description: 'https://integrate.api.nvidia.com/v1', providerType: 'custom', providerName: 'nvidia-nim', url: 'https://integrate.api.nvidia.com/v1', sampleModel: 'meta/llama-3.3-70b-instruct', needsKey: true, defaultCtx: 128000 },
      { label: 'Together AI', description: 'Hosted open-source models (Bring Your Own Key)', providerType: 'together', providerName: 'together', sampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', needsKey: true, defaultCtx: 128000 },
      { label: 'Fireworks AI', description: 'Hosted open-source models (Bring Your Own Key)', providerType: 'fireworks', providerName: 'fireworks', sampleModel: 'accounts/fireworks/models/deepseek-v3', needsKey: true, defaultCtx: 128000 },
      { label: 'Ollama (Offline / Local)', description: 'http://127.0.0.1:11434/v1 — no API key needed', providerType: 'custom', providerName: 'local-ollama', url: 'http://127.0.0.1:11434/v1', sampleModel: 'qwen3:4b', needsKey: false, defaultCtx: 16384, local: true },
      { label: 'LM Studio (Offline / Local)', description: 'http://127.0.0.1:1234/v1 — no API key needed', providerType: 'custom', providerName: 'local-lmstudio', url: 'http://127.0.0.1:1234/v1', sampleModel: 'qwen3-4b', needsKey: false, defaultCtx: 16384, local: true },
      { label: 'vLLM / llama.cpp (Offline / Local)', description: 'http://127.0.0.1:8000/v1 — no API key needed', providerType: 'custom', providerName: 'local-vllm', url: 'http://127.0.0.1:8000/v1', sampleModel: 'Qwen/Qwen3-4B', needsKey: false, defaultCtx: 32768, local: true },
      { label: 'Custom OpenAI-Compatible API (Any URL)', description: 'Connect any cloud gateway, self-hosted server, or private endpoint', providerType: 'custom', providerName: 'custom-api', url: 'https://api.example.com/v1', sampleModel: '', needsKey: false, allowCustomName: true, defaultCtx: 32768 },
    ];
    const presets = localOnly ? allPresets.filter(item => item.local || item.allowCustomName) : allPresets;
    const picked = await vscode.window.showQuickPick(presets, {
      title: 'Connect Any Model API in TrueForge (BYOM)',
      placeHolder: 'Choose a cloud provider, OpenAI-compatible gateway, or local offline runtime',
      ignoreFocusOut: true,
    });
    if (!picked) return;

    let providerName = picked.providerName;
    if (picked.allowCustomName) {
      const customName = await vscode.window.showInputBox({
        title: 'Custom API: Provider Name',
        prompt: 'Short lowercase slug for TrueForge (e.g. my-gateway, local-server, azure-openai)',
        value: localOnly ? 'local-custom' : 'my-api',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Provider name is required',
      });
      if (!customName?.trim()) return;
      providerName = customName.trim();
    }

    let endpointUrl = picked.url;
    if (picked.providerType === 'custom') {
      const enteredUrl = await vscode.window.showInputBox({
        title: `${picked.label}: Base URL`,
        prompt: 'OpenAI-compatible base URL reachable by TrueForge (usually ends with /v1)',
        value: picked.url ?? 'https://',
        ignoreFocusOut: true,
        validateInput: value => /^https?:\/\/.+/.test(value.trim()) ? undefined : 'Enter an http:// or https:// URL',
      });
      if (!enteredUrl?.trim()) return;
      endpointUrl = enteredUrl.trim();
    }

    let apiKey: string | undefined;
    if (picked.needsKey || picked.allowCustomName) {
      const enteredKey = await vscode.window.showInputBox({
        title: `${picked.label}: API Key`,
        prompt: picked.needsKey
          ? 'Stored securely inside local TrueForge (never saved in VS Code settings). Leave blank to keep an already-saved key.'
          : 'Optional API key (leave blank if your endpoint does not require auth). Stored only in local TrueForge.',
        password: true,
        placeHolder: picked.needsKey ? 'sk-... or provider API key' : '(optional)',
        ignoreFocusOut: true,
      });
      if (enteredKey === undefined) return;
      if (enteredKey.trim()) apiKey = enteredKey.trim();
    }

    const modelId = await vscode.window.showInputBox({
      title: `${picked.label}: Model ID`,
      prompt: 'Exact upstream model ID (must support tool calls)',
      value: picked.sampleModel,
      placeHolder: 'e.g. gpt-4o-mini, claude-3-5-sonnet-latest, qwen3:4b',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Model ID is required',
    });
    if (!modelId?.trim()) return;

    const ctxText = await vscode.window.showInputBox({
      title: `${picked.label}: Context Length (tokens)`,
      prompt: 'Model context window (used for adaptive context budgeting & TrueForge compaction triggers)',
      value: String(picked.defaultCtx),
      ignoreFocusOut: true,
      validateInput: value => {
        const n = Number(value.trim());
        return Number.isInteger(n) && n >= 2048 ? undefined : 'Enter an integer >= 2048';
      },
    });
    if (!ctxText?.trim()) return;
    const contextLength = Number(ctxText.trim());

    const baseUrl = vscode.workspace.getConfiguration('anvil').get<string>('trueForgeUrl', 'http://localhost:8790');
    try {
      const fullName = await registerModelProvider(baseUrl, {
        providerType: picked.providerType,
        providerName,
        endpointUrl,
        modelId: modelId.trim(),
        apiKey,
        contextLength,
      });
      const updated = [...new Set([...configuredModels(), fullName])];
      await saveModelProfiles(updated);
      selectedModel = fullName;
      await syncTrueForgeMetadata();
      panel.setModels(updated, selectedModel);
      panel.addActivity(`Connected ${fullName} via TrueForge (ctx ${contextLength.toLocaleString()})`);
      panel.setStatus('Ready');
    } catch (error) {
      const message = errorMessage(error);
      panel.setStatus('API setup failed');
      panel.addActivity(`API setup error: ${message}`);
      void vscode.window.showErrorMessage(`Could not connect model in TrueForge: ${message}`);
    }
  }
}

export function deactivate(): void {
  activeRun++;
  void activeClient?.cancel();
  void bridge?.stop();
}

function configuredModels(): string[] {
  const value = vscode.workspace.getConfiguration('anvil').get<string[]>('modelProfiles', []);
  return [...new Set(value.map(model => model.trim()).filter(Boolean))];
}

function resolveContextBudget(_modelName: string, contextLength?: number): number {
  const configured = vscode.workspace.getConfiguration('anvil').get<number>('contextBudgetTokens', 0);
  if (configured > 0) return Math.max(1000, configured);
  if (contextLength && contextLength <= 32_768) {
    return Math.min(6000, Math.max(1800, Math.floor(contextLength * 0.2)));
  }
  return 6000;
}

function resolveCompactionTrigger(contextLength?: number): number {
  if (contextLength && contextLength <= 32_768) {
    return Math.max(6000, Math.floor(contextLength * 0.65));
  }
  return 28_000;
}

function isLocalModelProfile(modelName: string): boolean {
  return /^(local-|ollama|lmstudio|vllm|llamacpp)/i.test(modelName.trim());
}

function toReviewView(proposal: Proposal, diagnosticsByPath?: Map<string, FileDiagnostics>): ReviewView {
  return {
    proposalId: proposal.id,
    files: proposal.files.map(file => {
      const analysis = analyzeProposalFile(file);
      return {
        path: file.path,
        category: analysis.category,
        isNewFile: analysis.isNewFile,
        addedLines: analysis.addedLines,
        removedLines: analysis.removedLines,
        touchedSymbols: analysis.touchedSymbols,
        diagnostics: diagnosticsByPath?.get(file.path) ?? { status: 'checking', newErrorCount: 0, issues: [] },
        hunks: file.hunks.map(hunk => {
          const hunkAnalysis = analysis.hunks.get(hunk.id);
          return {
            id: hunk.id,
            header: hunk.header,
            oldLines: hunk.oldLines,
            newLines: hunk.newLines,
            diffLines: hunk.diffLines,
            addedLines: hunkAnalysis?.addedLines ?? 0,
            removedLines: hunkAnalysis?.removedLines ?? 0,
            symbol: hunkAnalysis?.symbol,
          };
        }),
      };
    }),
  };
}

function proposalIdFromArgs(args?: string): string | undefined {
  try {
    const parsed = JSON.parse(args ?? '{}') as Record<string, unknown>;
    return typeof parsed.proposal_id === 'string' ? parsed.proposal_id : undefined;
  } catch {
    return undefined;
  }
}

function commandFromArgs(args?: string): string | undefined {
  try {
    const parsed = JSON.parse(args ?? '{}') as Record<string, unknown>;
    return typeof parsed.command === 'string' ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
