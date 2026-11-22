import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { FileDiagnostics, FileIntent } from '../review/analysis';
import type { ContextSelection } from '../context/assembly';

export interface ReviewHunkView {
  id: string;
  header: string;
  oldLines: string[];
  newLines: string[];
  diffLines: string[];
  addedLines: number;
  removedLines: number;
  symbol?: string;
}

export interface ReviewFileView {
  path: string;
  category: FileIntent;
  isNewFile: boolean;
  addedLines: number;
  removedLines: number;
  touchedSymbols: string[];
  diagnostics: FileDiagnostics;
  hunks: ReviewHunkView[];
}

export interface ReviewView {
  proposalId: string;
  files: ReviewFileView[];
}

export type PanelAction =
  | { type: 'submit'; prompt: string }
  | { type: 'cancel' }
  | { type: 'approve'; proposalId: string; selectedHunkIds: string[] }
  | { type: 'verify'; proposalId: string; selectedHunkIds: string[] }
  | { type: 'cancelVerify' }
  | { type: 'reject'; proposalId: string }
  | { type: 'preview'; proposalId: string; path: string }
  | { type: 'openContext'; path: string }
  | { type: 'undo' }
  | { type: 'model'; modelName: string }
  | { type: 'connectApi' }
  | { type: 'pickModels' }
  | { type: 'openSession'; sessionId: string };

export interface TelemetryState {
  turns: number;
  toolCalls: number;
  savedTokens: number;
  contextUsedTokens: number;
  contextBudgetTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
  isLocal: boolean;
  elapsedMs: number;
}

interface PanelState {
  status: string;
  running: boolean;
  cancelling: boolean;
  applying: boolean;
  canUndo: boolean;
  stream: string;
  reasoningSnippet: string;
  activities: string[];
  context: ContextSelection[];
  contextUsedTokens: number;
  contextBudgetTokens: number;
  telemetry?: TelemetryState;
  review?: ReviewView;
  verification?: { proposalId: string; selection: string; status: 'running' | 'passed' | 'failed'; message: string };
  models: string[];
  modelName: string;
  sessionId?: string;
}

export class ForgePanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'anvil.panel';

  private view?: vscode.WebviewView;
  private readonly actions = new vscode.EventEmitter<PanelAction>();
  readonly onAction = this.actions.event;
  private readonly state: PanelState = {
    status: 'Ready',
    running: false,
    cancelling: false,
    applying: false,
    canUndo: false,
    stream: '',
    reasoningSnippet: '',
    activities: [],
    context: [],
    contextUsedTokens: 0,
    contextBudgetTokens: 0,
    models: [],
    modelName: '',
  };

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const nonce = randomNonce();
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    view.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${style}" rel="stylesheet"><title>Anvil</title></head>
<body>
  <header class="top">
    <div class="brand">
      <span class="brand-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none">
          <path d="M10 1.8L12.3 7.2L18 9.5L12.3 11.8L10 17.5L7.7 11.8L2 9.5L7.7 7.2L10 1.8Z" fill="currentColor"/>
        </svg>
      </span>
      <div class="brand-text">
        <strong>Anvil</strong>
        <span class="brand-sub">TrueForge</span>
      </div>
    </div>
    <span id="status" class="status">Ready</span>
  </header>
  <section class="settings">
    <div class="settings-head">
      <label for="model">Model</label>
      <div class="settings-tools">
        <button id="pickModels" class="pill-btn" title="Choose which TrueForge models appear in your profile list">Manage</button>
        <button id="connectApi" class="pill-btn accent" title="Connect any Cloud API (OpenAI, Anthropic, Gemini, OpenRouter, Groq, Custom) or Offline model (Ollama, LM Studio, vLLM) in TrueForge">+ Connect API</button>
      </div>
    </div>
    <div class="select-wrap">
      <select id="model" aria-label="TrueForge model"></select>
    </div>
  </section>
  <section id="telemetry" class="telemetry hidden" aria-label="Run telemetry"></section>
  <main class="content">
    <section class="conversation" aria-live="polite">
      <div class="section-head"><span class="section-title">Response</span></div>
      <div id="thinkingBar" class="thinking-bar hidden" role="status" aria-live="polite">
        <div class="thinking-row">
          <span id="thinkingGlyph" class="thinking-glyph" aria-hidden="true">✦</span>
          <span id="thinkingText" class="thinking-text">Forging…</span>
          <span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span id="thinkingTimer" class="thinking-timer">0.0s</span>
        </div>
        <div id="thinkingDetail" class="thinking-detail hidden"></div>
      </div>
      <div id="stream" class="stream muted">Describe a change, or press Ctrl+Alt+F on selected code.</div>
      <div id="activities" class="activities"></div>
    </section>
    <section id="contextSection" class="context hidden">
      <div class="section-head">
        <span id="contextTitle" class="section-title">Chosen context</span>
      </div>
      <div class="budget-track"><div id="budgetFill" class="budget-fill"></div></div>
      <div id="context" class="context-list"></div>
    </section>
    <section id="reviewSection" class="review hidden">
      <div class="section-head"><span class="section-title">Review changes</span></div>
      <div id="review"></div>
      <pre id="verificationResult" class="verification-result hidden" aria-live="polite"></pre>
      <div class="review-actions">
        <button id="verify" class="secondary" title="Run pytest on the selected hunks in a temporary copy">Verify selected</button>
        <button id="reject" class="secondary">Reject all</button>
        <button id="approve" class="primary">Apply selected</button>
      </div>
    </section>
  </main>
  <footer class="composer-wrap">
    <div class="composer-card">
      <textarea id="prompt" rows="3" placeholder="Ask to edit, refactor, or inspect… (@file:path, @symbol:name)" aria-label="Agent instruction"></textarea>
      <div class="composer-actions">
        <button id="undo" class="pill-btn" title="Undo the last applied agent edit">↩ Undo</button>
        <span class="shortcut-hint">Ctrl+↵</span>
        <button id="cancel" class="secondary compact" disabled>Stop</button>
        <button id="send" class="primary compact">Send</button>
      </div>
    </div>
    <div class="session-bar">
      <div id="session" class="session"></div>
      <button id="openSession" class="pill-btn hidden" type="button" title="Inspect turns, tool calls, and compaction in TrueForge">Inspect ↗</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body></html>`;
    view.webview.onDidReceiveMessage((message: PanelAction) => {
      if (message && typeof message.type === 'string') this.actions.fire(message);
    });
    this.pushState();
  }

  show(): void {
    void vscode.commands.executeCommand('anvil.panel.focus');
  }

  resetRun(): void {
    this.state.stream = '';
    this.state.reasoningSnippet = '';
    this.state.activities = [];
    this.state.context = [];
    this.state.contextUsedTokens = 0;
    this.state.contextBudgetTokens = 0;
    this.state.telemetry = undefined;
    this.state.review = undefined;
    this.state.sessionId = undefined;
    this.state.applying = false;
    this.pushState();
  }

  setReasoningSnippet(snippet: string): void {
    this.state.reasoningSnippet = snippet;
    this.pushState();
  }

  setTelemetry(telemetry?: TelemetryState): void {
    this.state.telemetry = telemetry ? { ...telemetry } : undefined;
    this.pushState();
  }

  setRunState(running: boolean, cancelling = false): void {
    this.state.running = running;
    this.state.cancelling = cancelling;
    if (!running && !cancelling) this.state.applying = false;
    this.pushState();
  }

  setApplying(applying: boolean): void {
    this.state.applying = applying;
    this.pushState();
  }

  setCanUndo(canUndo: boolean): void {
    this.state.canUndo = canUndo;
    this.pushState();
  }

  setStatus(status: string): void {
    this.state.status = status;
    this.pushState();
  }

  appendStream(text: string): void {
    this.state.stream += text;
    this.pushState();
  }

  clearStream(): void {
    this.state.stream = '';
    this.state.reasoningSnippet = '';
    this.state.sessionId = undefined;
    this.pushState();
  }

  addActivity(text: string): void {
    this.state.activities.push(text);
    this.state.activities = this.state.activities.slice(-30);
    this.pushState();
  }

  setContext(selections: PanelState['context'], usedTokens = 0, budgetTokens = 0): void {
    this.state.context = selections;
    this.state.contextUsedTokens = usedTokens;
    this.state.contextBudgetTokens = budgetTokens;
    this.pushState();
  }

  setReview(review?: ReviewView): void {
    if (review?.proposalId !== this.state.review?.proposalId) this.state.verification = undefined;
    this.state.review = review;
    this.pushState();
  }

  setVerification(verification?: PanelState['verification']): void {
    this.state.verification = verification;
    this.pushState();
  }

  setModels(models: string[], selected: string): void {
    this.state.models = models;
    this.state.modelName = selected;
    this.pushState();
  }

  setSession(sessionId: string): void {
    this.state.sessionId = sessionId;
    this.pushState();
  }

  private pushState(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  dispose(): void {
    this.actions.dispose();
  }
}

function randomNonce(): string {
  return randomBytes(24).toString('base64');
}
