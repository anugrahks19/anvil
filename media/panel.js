const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let review;
let selected = new Set();
let verification;
let applying = false;
let activeCategory = 'all';
let currentModel = '';
let currentSessionId = '';
let thinkingTimerId = null;
let thinkingStartedAt = 0;
let glyphFrame = 0;
let lastVerbChangeAt = 0;
let currentVerbKey = '';
let currentVerb = '';
let shuffledVerbs = [];
let shuffledIndex = 0;
let latestState = null;

// Claude-style symmetric starburst pulse frames (smooth forward & reverse)
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERB_HOLD_MS = 3800;

const VERB_SETS = {
  context: [
    'Scouting the repo…',
    'Following import breadcrumbs…',
    'Packing the context lunchbox…',
    'Mapping secret passageways…',
  ],
  connecting: [
    'Warming up the forge…',
    'Waking up the GPU…',
    'Stretching neural legs…',
    'Dialing TrueForge…',
  ],
  retrying: [
    'Shaking off a hiccup…',
    'Giving it another honest try…',
    'Dusting off the request…',
  ],
  switching: [
    'Tagging in the backup brain…',
    'Plan B engaged — swapping models…',
    'Calling in the relief pitcher…',
  ],
  applying: [
    'Checking hashes twice…',
    'Hammering hunks into place…',
    'Locking in your reviewed edits…',
  ],
  cancelling: [
    'Pulling the emergency brake…',
    'Tidying up the workbench…',
    'Discarding unapproved edits…',
  ],
  running: [
    'Forging…',
    'Spelunking through ASTs…',
    'Brewing artisanal diffs…',
    'Consulting the rubber duck…',
    'Untangling spaghetti…',
    'Herding semicolons…',
    'Pondering the orb…',
    'Caffeinating the context window…',
    'Negotiating with the compiler…',
    'Reticulating splines…',
    'Marinating on edge cases…',
    'Counting brackets twice…',
    'Taming wild imports…',
    'Combobulating…',
    'Percolating…',
    'Noodling on architecture…',
    'Squinting at line numbers…',
    'Whispering to the bytecode…',
    'Polishing the hunks…',
    'Schlepping tokens…',
    'Galvanizing the diff…',
    'Summoning clean code…',
  ],
};

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function stageKeyForState(state) {
  const status = (state?.status || '').toLowerCase();
  if (state?.cancelling || status.includes('cancelling')) return 'cancelling';
  if (state?.applying || status.includes('applying')) return 'applying';
  if (status.includes('selecting context')) return 'context';
  if (status.includes('switching')) return 'switching';
  if (status.includes('retrying')) return 'retrying';
  if (status.includes('connecting') || status.includes('resuming')) return 'connecting';
  return 'running';
}

function pickNextVerb(key) {
  if (key !== currentVerbKey || shuffledVerbs.length === 0) {
    currentVerbKey = key;
    shuffledVerbs = shuffle(VERB_SETS[key] || VERB_SETS.running);
    shuffledIndex = 0;
  }
  const verb = shuffledVerbs[shuffledIndex % shuffledVerbs.length];
  shuffledIndex++;
  if (shuffledIndex >= shuffledVerbs.length) {
    shuffledVerbs = shuffle(VERB_SETS[key] || VERB_SETS.running);
    shuffledIndex = 0;
  }
  return verb;
}

function updateThinkingDetail() {
  const detail = $('thinkingDetail');
  const snippet = (latestState?.reasoningSnippet || '').trim();
  detail.textContent = snippet;
  detail.classList.toggle('hidden', !snippet);
}

function setVerbText(text) {
  if (text === currentVerb) return;
  currentVerb = text;
  const elText = $('thinkingText');
  elText.classList.remove('phrase-in');
  void elText.offsetWidth;
  elText.textContent = text;
  elText.classList.add('phrase-in');
}

function tickThinking() {
  const bar = $('thinkingBar');
  if (!latestState) return;
  const isReviewPaused = latestState.review && !latestState.applying && !latestState.cancelling && /review hunks/i.test(latestState.status || '');
  const show = Boolean((latestState.running || latestState.cancelling || latestState.applying) && !isReviewPaused);
  bar.classList.toggle('hidden', !show);
  if (!show) return;

  const now = Date.now();
  const key = stageKeyForState(latestState);
  if (!currentVerb || key !== currentVerbKey || now - lastVerbChangeAt >= VERB_HOLD_MS) {
    lastVerbChangeAt = now;
    setVerbText(pickNextVerb(key));
  }

  $('thinkingGlyph').textContent = GLYPHS[glyphFrame % GLYPHS.length];
  glyphFrame++;
  const elapsedSec = Math.max(0, (now - thinkingStartedAt) / 1000);
  $('thinkingTimer').textContent = `${elapsedSec.toFixed(1)}s`;
  updateThinkingDetail();
}

function syncThinkingLoop(state) {
  latestState = state;
  const isReviewPaused = state.review && !state.applying && !state.cancelling && /review hunks/i.test(state.status || '');
  const active = Boolean((state.running || state.cancelling || state.applying) && !isReviewPaused);
  if (active) {
    if (!thinkingTimerId) {
      thinkingStartedAt = Date.now() - (state.telemetry?.elapsedMs || 0);
      glyphFrame = 0;
      lastVerbChangeAt = 0;
      currentVerbKey = '';
      currentVerb = '';
      tickThinking();
      thinkingTimerId = setInterval(tickThinking, 140);
    } else {
      // Only update the live reasoning line & stage transitions on incoming token deltas;
      // never advance the spinner or verb cadence faster than the steady timer.
      const key = stageKeyForState(state);
      if (key !== currentVerbKey) {
        lastVerbChangeAt = Date.now();
        setVerbText(pickNextVerb(key));
      }
      updateThinkingDetail();
    }
  } else {
    if (thinkingTimerId) {
      clearInterval(thinkingTimerId);
      thinkingTimerId = null;
    }
    currentVerb = '';
    currentVerbKey = '';
    $('thinkingBar').classList.add('hidden');
  }
}

function post(message) { vscode.postMessage(message); }
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderModels(models, modelName) {
  const select = $('model');
  if (JSON.stringify([...select.options].map(o => o.value)) !== JSON.stringify(models)) {
    const options = models.map(name => {
      const option = el('option', '', name);
      option.value = name;
      return option;
    });
    if (models.length === 0) {
      const option = el('option', '', 'Click "+ Connect API" to add a model');
      option.value = '';
      options.push(option);
    }
    select.replaceChildren(...options);
  }
  currentModel = modelName;
  select.value = modelName;
}

const CATEGORY_LABELS = {
  all: 'All',
  production: 'Production',
  test: 'Test',
  docs: 'Docs',
  config: 'Config',
};

function updateApproveLabel() {
  const btn = $('approve');
  const verify = $('verify');
  const result = $('verificationResult');
  const belongsToReview = Boolean(review && verification?.proposalId === review.proposalId);
  const checking = belongsToReview && verification.status === 'running';
  const sameSelection = belongsToReview && verification.selection === JSON.stringify([...selected].sort());
  const visible = checking || sameSelection;
  result.classList.toggle('hidden', !visible);
  result.textContent = visible ? verification.message : '';
  verify.textContent = checking ? 'Stop verification' : 'Verify selected';
  verify.disabled = applying || (!checking && selected.size === 0);
  btn.disabled = applying || checking || selected.size === 0;
  $('reject').disabled = applying || checking;
  if (!review) { btn.textContent = 'Apply selected'; return; }
  const total = review.files.reduce((sum, file) => sum + file.hunks.length, 0);
  btn.textContent = `Apply selected (${selected.size}/${total})`;
}

function renderDiagBadge(diag) {
  if (!diag || diag.status === 'checking') return el('span', 'badge neutral', 'Checking…');
  if (diag.status === 'errors') return el('span', 'badge danger', `⚠ ${diag.newErrorCount} error${diag.newErrorCount === 1 ? '' : 's'}`);
  if (diag.status === 'clean') return el('span', 'badge ok', '✓ 0 new errors');
  return el('span', 'badge neutral', 'Syntax n/a');
}

function renderReview(value) {
  const section = $('reviewSection');
  const host = $('review');
  if (!value) {
    section.classList.add('hidden');
    host.replaceChildren();
    review = undefined;
    activeCategory = 'all';
    updateApproveLabel();
    return;
  }
  if (!review || review.proposalId !== value.proposalId) {
    selected = new Set(value.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
    activeCategory = 'all';
  } else {
    const previous = new Set(review.files.flatMap(file => file.hunks.map(hunk => hunk.id)));
    selected = new Set(value.files.flatMap(file => file.hunks.map(hunk => hunk.id))
      .filter(id => !previous.has(id) || selected.has(id)));
  }
  review = value;
  section.classList.remove('hidden');
  host.replaceChildren();

  const totalAdded = value.files.reduce((sum, f) => sum + (f.addedLines || 0), 0);
  const totalRemoved = value.files.reduce((sum, f) => sum + (f.removedLines || 0), 0);
  const totalErrors = value.files.reduce((sum, f) => sum + (f.diagnostics?.newErrorCount || 0), 0);
  const checking = value.files.some(f => f.diagnostics?.status === 'checking');
  const summary = el('div', 'blast-summary');
  summary.append(
    el('span', '', `${value.files.length} file${value.files.length === 1 ? '' : 's'}`),
    el('span', 'delta-add', `+${totalAdded}`),
    el('span', 'delta-del', `-${totalRemoved}`),
    checking
      ? el('span', 'badge neutral', 'Checking diagnostics…')
      : totalErrors > 0
        ? el('span', 'badge danger', `⚠ ${totalErrors} pre-apply error${totalErrors === 1 ? '' : 's'}`)
        : el('span', 'badge ok', '✓ 0 new errors'),
  );
  host.append(summary);

  const counts = { all: value.files.length, production: 0, test: 0, docs: 0, config: 0 };
  for (const file of value.files) {
    counts[file.category] = (counts[file.category] || 0) + 1;
  }
  const presentCategories = ['production', 'test', 'docs', 'config'].filter(cat => counts[cat] > 0);
  if (presentCategories.length > 1) {
    const tabs = el('div', 'intent-tabs');
    for (const cat of ['all', ...presentCategories]) {
      const tab = el('button', `intent-tab${activeCategory === cat ? ' active' : ''}`, `${CATEGORY_LABELS[cat]} (${counts[cat]})`);
      tab.type = 'button';
      tab.addEventListener('click', () => {
        activeCategory = cat;
        renderReview(review);
      });
      tabs.append(tab);
    }
    host.append(tabs);
  } else {
    activeCategory = 'all';
  }

  const visibleFiles = activeCategory === 'all'
    ? value.files
    : value.files.filter(file => file.category === activeCategory);

  for (const file of visibleFiles) {
    const group = el('div', 'review-file');
    const head = el('div', 'file-head');
    const title = el('button', 'file-title', file.path);
    title.type = 'button';
    title.title = 'Open side-by-side diff in editor';
    title.addEventListener('click', () => post({type:'preview', proposalId:value.proposalId, path:file.path}));
    head.append(title);

    const meta = el('div', 'file-meta');
    meta.append(
      el('span', `badge intent-${file.category}`, CATEGORY_LABELS[file.category] || file.category),
      ...(file.isNewFile ? [el('span', 'badge neutral', 'New file')] : []),
      el('span', 'delta-add', `+${file.addedLines || 0}`),
      el('span', 'delta-del', `-${file.removedLines || 0}`),
      renderDiagBadge(file.diagnostics),
    );
    head.append(meta);
    if (file.touchedSymbols?.length) {
      head.append(el('div', 'file-symbols', `Symbols: ${file.touchedSymbols.join(', ')}`));
    }
    if (file.diagnostics?.issues?.length) {
      const box = el('div', 'diag-list');
      for (const issue of file.diagnostics.issues.slice(0, 3)) {
        const prefix = issue.line ? `L${issue.line}: ` : '';
        box.append(el('div', 'diag-item', `${prefix}${issue.message} (${issue.source})`));
      }
      head.append(box);
    }
    group.append(head);

    for (const hunk of file.hunks) {
      const kept = selected.has(hunk.id);
      const row = el('div', `hunk${kept ? '' : ' skipped'}`);
      const headerRow = el('div', 'hunk-head');
      const label = el('label', 'hunk-label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = kept;
      const toggleBtn = el('button', `hunk-toggle${kept ? ' keep' : ' skip'}`, kept ? 'Keep' : 'Skip');
      toggleBtn.type = 'button';
      const setKept = (next) => {
        if (next) selected.add(hunk.id);
        else selected.delete(hunk.id);
        checkbox.checked = next;
        row.classList.toggle('skipped', !next);
        toggleBtn.className = `hunk-toggle${next ? ' keep' : ' skip'}`;
        toggleBtn.textContent = next ? 'Keep' : 'Skip';
        updateApproveLabel();
      };
      checkbox.addEventListener('change', () => setKept(checkbox.checked));
      toggleBtn.addEventListener('click', () => setKept(!selected.has(hunk.id)));

      const titleText = hunk.symbol ? `${hunk.symbol} · ${hunk.header}` : hunk.header;
      label.append(checkbox, el('span', 'hunk-title', titleText));
      const hunkStats = el('span', 'hunk-stats', `+${hunk.addedLines || 0}/-${hunk.removedLines || 0}`);
      headerRow.append(label, hunkStats, toggleBtn);
      row.append(headerRow);
      const code = el('pre', 'hunk-code');
      for (const line of hunk.diffLines) {
        const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'unchanged';
        code.append(el('span', kind, `${line}\n`));
      }
      row.append(code);
      group.append(row);
    }
    host.append(group);
  }
  updateApproveLabel();
}

function compactNum(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function makeTelemetryChip(label, value, extraClass) {
  const chip = el('span', extraClass ? `telemetry-chip ${extraClass}` : 'telemetry-chip');
  if (label) chip.append(el('span', 't-label', label));
  if (value !== undefined) chip.append(document.createTextNode(value));
  return chip;
}

function renderTelemetry(telemetry, harness, running) {
  const bar = $('telemetry');
  if (!telemetry) { bar.classList.add('hidden'); bar.replaceChildren(); return; }
  bar.classList.remove('hidden');
  const chips = [
    makeTelemetryChip('Turns', String(telemetry.turns)),
    makeTelemetryChip('Tools', String(telemetry.toolCalls)),
  ];
  if (telemetry.contextBudgetTokens) {
    chips.push(makeTelemetryChip('Ctx', `${compactNum(telemetry.contextUsedTokens)}/${compactNum(telemetry.contextBudgetTokens)}`));
  }
  if (telemetry.inputTokens || telemetry.outputTokens) {
    chips.push(makeTelemetryChip('Tok', `${compactNum(telemetry.inputTokens)}↓/${compactNum(telemetry.outputTokens)}↑`));
  }
  if (telemetry.cacheReadTokens > 0) {
    const pct = telemetry.inputTokens > 0 ? Math.min(100, Math.round((telemetry.cacheReadTokens / telemetry.inputTokens) * 100)) : 0;
    chips.push(makeTelemetryChip('Cache', pct ? `${pct}%` : compactNum(telemetry.cacheReadTokens), 'highlight'));
  }
  if (telemetry.savedTokens > 0) {
    chips.push(makeTelemetryChip('Saved', `~${compactNum(telemetry.savedTokens)}`, 'highlight'));
  }
  if (telemetry.elapsedMs > 0) {
    chips.push(makeTelemetryChip('', `${(telemetry.elapsedMs / 1000).toFixed(1)}s`));
  }
  if (typeof telemetry.costUsd === 'number') {
    chips.push(makeTelemetryChip('', telemetry.costUsd === 0 ? '$0' : `$${telemetry.costUsd.toFixed(4)}`, telemetry.costUsd === 0 ? 'local' : ''));
  } else if (telemetry.isLocal) {
    chips.push(makeTelemetryChip('', 'Local $0', 'local'));
  }
  for (const [type, label] of [['subagent', 'TrueForge subagents'], ['compaction', 'TrueForge compaction']]) {
    const phases = Object.values(harness[type]);
    if (phases.length === 0) continue;
    const finished = phases.filter(phase => phase === 'finished').length;
    const pending = phases.length - finished;
    const parts = [];
    if (pending) parts.push(`${pending} ${running ? 'running' : 'unfinished'}`);
    if (finished) parts.push(`${finished} finished`);
    chips.push(makeTelemetryChip(label, parts.join(' · '), finished && !pending ? 'highlight' : ''));
  }
  bar.replaceChildren(...chips);
}

function appendInlineFormatted(parent, text) {
  // Safely render `inline code` and **bold** spans as pure DOM nodes (no innerHTML)
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parent.append(el('code', 'inline-code', token.slice(1, -1)));
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parent.append(el('strong', '', token.slice(2, -2)));
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderStream(streamEl, text, isRunning, hasReview) {
  if (!text) {
    streamEl.textContent = isRunning ? '' : 'Describe a change, or press Ctrl+Alt+F on selected code.';
    streamEl.classList.toggle('muted', true);
    streamEl.classList.toggle('streaming', false);
    return;
  }
  streamEl.classList.toggle('muted', false);
  streamEl.classList.toggle('streaming', Boolean(isRunning && !hasReview));

  const fragment = document.createDocumentFragment();
  const fenceRegex = /```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendInlineFormatted(fragment, text.slice(lastIndex, match.index));
    }
    const codeText = match[1].replace(/\r?\n$/, '');
    fragment.append(el('pre', 'code-block', codeText));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    appendInlineFormatted(fragment, text.slice(lastIndex));
  }
  streamEl.replaceChildren(fragment);
}

function renderActivity(item) {
  const text = String(item || '');
  let kind = '';
  let tag = '';
  let body = text;

  const colonIdx = text.indexOf(':');
  if (colonIdx > 0 && colonIdx <= 34) {
    const prefix = text.slice(0, colonIdx).trim();
    const rest = text.slice(colonIdx + 1).trim();
    const lower = prefix.toLowerCase();
    if (lower === 'tool') {
      kind = 'tool';
      tag = 'TOOL';
      body = rest;
    } else if (lower.includes('compression')) {
      kind = 'saved';
      tag = 'SAVED';
      body = rest;
    } else if (lower.includes('loop-breaker')) {
      kind = 'warn';
      tag = 'GUARD';
      body = rest;
    } else if (lower.includes('error') || lower.includes('failure') || lower.includes('failed')) {
      kind = 'err';
      tag = 'ERR';
      body = rest || text;
    } else if (lower.includes('fallback') || lower.includes('switching')) {
      kind = 'fallback';
      tag = 'FALLBACK';
      body = `${prefix}: ${rest}`;
    } else if (lower.includes('trueforge harness')) {
      tag = 'HARNESS';
      body = rest;
    } else if (lower.includes('pre-apply diagnostics')) {
      kind = rest.toLowerCase().includes('0 new') ? 'saved' : 'warn';
      tag = 'CHECK';
      body = rest;
    } else if (lower.includes('subagent')) {
      kind = 'tool';
      tag = 'SUBAGENT';
      body = rest;
    }
  } else {
    const lower = text.toLowerCase();
    if (lower.includes('hybrid') || lower.includes('fallback') || lower.includes('switching')) {
      kind = 'fallback';
      tag = 'FALLBACK';
    } else if (lower.includes('connected') || lower.includes('updated') || lower.includes('synced')) {
      kind = 'saved';
      tag = 'OK';
    } else if (lower.includes('error') || lower.includes('failed')) {
      kind = 'err';
      tag = 'ERR';
    }
  }

  const row = el('div', kind ? `activity ${kind}` : 'activity');
  if (tag) row.append(el('span', 'act-tag', tag));
  row.append(el('span', '', body));
  return row;
}

function renderContext(selections, usedTokens, budgetTokens) {
  const section = $('contextSection');
  const host = $('context');
  const fill = $('budgetFill');
  section.classList.toggle('hidden', selections.length === 0);
  $('contextTitle').textContent = budgetTokens
    ? `Chosen context · ~${usedTokens.toLocaleString()} / ${budgetTokens.toLocaleString()} tokens`
    : 'Chosen context';
  if (fill) {
    const pct = budgetTokens > 0 ? Math.min(100, Math.max(2, Math.round((usedTokens / budgetTokens) * 100))) : 0;
    fill.style.width = selections.length > 0 ? `${pct}%` : '0%';
  }

  const cards = selections.map(item => {
    const card = el('div', 'context-card');
    const top = el('div', 'context-card-top');
    const nameEl = el('button', 'context-name context-link');
    nameEl.type = 'button';
    const normalized = String(item.path || '').replace(/\\/g, '/');
    const slashIdx = normalized.lastIndexOf('/');
    if (slashIdx >= 0) {
      nameEl.append(
        el('span', 'context-dir', normalized.slice(0, slashIdx + 1)),
        document.createTextNode(normalized.slice(slashIdx + 1)),
      );
    } else {
      nameEl.textContent = normalized;
    }
    if (item.line) nameEl.append(el('span', 'context-dir', `:${item.line}`));
    nameEl.title = `Open ${normalized}${item.line ? `:${item.line}` : ''}`;
    nameEl.addEventListener('click', () => post({ type: 'openContext', path: item.path }));
    top.append(nameEl, el('span', 'context-tok', `~${compactNum(item.tokens)} tok`));
    card.append(top);

    const reasons = String(item.reason || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    if (reasons.length > 0) {
      const reasonRow = el('div', 'context-reasons');
      for (const reason of reasons) {
        const isGraph = /imported by|referenced by|1-hop/i.test(reason);
        reasonRow.append(el('span', isGraph ? 'reason-pill graph' : 'reason-pill', reason));
      }
      card.append(reasonRow);
    }
    return card;
  });
  host.replaceChildren(...cards);
}

function updateStatusBadge(state) {
  const statusEl = $('status');
  const text = state.status || 'Ready';
  const lower = text.toLowerCase();
  const isBusy = Boolean(state.running || state.cancelling || state.applying);
  const isErr = !isBusy && (lower.includes('failed') || lower.includes('error') || lower.includes('uncertain'));
  const isOk = !isBusy && !isErr && (
    lower === 'ready' ||
    lower.includes('completed') ||
    lower.includes('applied') ||
    lower.includes('undone') ||
    lower.includes('connected')
  );
  statusEl.textContent = text;
  statusEl.classList.toggle('busy', isBusy);
  statusEl.classList.toggle('err', isErr);
  statusEl.classList.toggle('ok', isOk);
}

function render(state) {
  updateStatusBadge(state);
  renderTelemetry(state.telemetry, state.harness, state.running);
  syncThinkingLoop(state);
  renderStream($('stream'), state.stream, Boolean(state.running), Boolean(state.review));
  $('activities').replaceChildren(...state.activities.map(renderActivity));
  renderContext(state.context || [], state.contextUsedTokens || 0, state.contextBudgetTokens || 0);
  renderModels(state.models, state.modelName);
  verification = state.verification;
  applying = Boolean(state.applying);
  renderReview(state.review);
  currentSessionId = state.sessionId || '';
  $('session').textContent = currentSessionId ? `TrueForge · ${currentSessionId}` : '';
  $('openSession').classList.toggle('hidden', !currentSessionId);
  const active = Boolean(state.running);
  $('cancel').disabled = !active || Boolean(state.cancelling);
  $('send').disabled = active || Boolean(state.cancelling);
  $('undo').disabled = !state.canUndo || active || Boolean(state.cancelling);
}

window.addEventListener('message', event => {
  if (event.data?.type === 'state') render(event.data.state);
});

const promptEl = $('prompt');
function autoResizePrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(150, Math.max(62, promptEl.scrollHeight))}px`;
}
promptEl.addEventListener('input', autoResizePrompt);

$('send').addEventListener('click', () => {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  post({type:'submit', prompt});
  promptEl.value = '';
  promptEl.style.height = '62px';
});
promptEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); $('send').click();
  }
});
$('cancel').addEventListener('click', () => post({type:'cancel'}));
$('undo').addEventListener('click', () => post({type:'undo'}));
$('reject').addEventListener('click', () => review && post({type:'reject', proposalId:review.proposalId}));
$('approve').addEventListener('click', () => review && post({type:'approve', proposalId:review.proposalId, selectedHunkIds:[...selected]}));
$('verify').addEventListener('click', () => {
  if (!review) return;
  if (verification?.status === 'running') post({type:'cancelVerify'});
  else post({type:'verify', proposalId:review.proposalId, selectedHunkIds:[...selected]});
});
$('model').addEventListener('change', event => {
  if (event.target.value !== currentModel) post({type:'model', modelName:event.target.value});
});
$('connectApi').addEventListener('click', () => post({type:'connectApi'}));
$('pickModels').addEventListener('click', () => post({type:'pickModels'}));
$('openSession').addEventListener('click', () => currentSessionId && post({type:'openSession', sessionId:currentSessionId}));
