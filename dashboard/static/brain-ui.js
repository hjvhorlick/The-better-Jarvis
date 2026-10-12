/* Persistent Brain controls for the real Node dashboard. Data stays in the local app store. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    panel: $('win-brain'), button: $('btn-toggle-brain'), chip: $('brain-active-topic'),
    status: $('brain-status'), feedback: $('brain-feedback'), providerTest: $('brain-provider-test'),
    backup: $('brain-backup'), backupSelect: $('brain-backup-select'), restore: $('brain-restore'),
    topicSelect: $('brain-topic-select'), topicStatus: $('brain-topic-status'), topicGoal: $('brain-topic-goal'),
    topicSummary: $('brain-topic-summary'), topicNext: $('brain-topic-next'), topicSave: $('brain-topic-save'),
    topicCreate: $('brain-topic-create'), topicTitle: $('brain-topic-title'), topicResume: $('brain-topic-resume'),
    memorySearch: $('brain-memory-search'), memorySearchGo: $('brain-memory-search-go'),
    memoryCreate: $('brain-memory-create'), memoryCategory: $('brain-memory-category'), memoryKey: $('brain-memory-key'),
    memoryValue: $('brain-memory-value'), memoryList: $('brain-memory-list'),
    decisionCreate: $('brain-decision-create'), decisionValue: $('brain-decision-value'), decisionList: $('brain-decision-list'),
    taskCreate: $('brain-task-create'), taskTitle: $('brain-task-title'), taskList: $('brain-task-list'),
    researchList: $('brain-research-list'),
  };
  if (!el.panel || !el.status || typeof window._authFetch !== 'function') return;

  let topics = [];
  let activeTopicId = '';
  let selectedTopicId = '';
  let refreshing = false;
  let providerTestText = 'not tested';

  async function api(url, options = {}) {
    const init = { ...options };
    if (options.body !== undefined && typeof options.body !== 'string') {
      init.headers = { ...(options.headers || {}), 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    const response = await window._authFetch(url, init);
    let body = null;
    try { body = await response.json(); } catch (_) { /* empty or non-JSON response */ }
    if (!response.ok) {
      throw new Error(body && (body.error || body.detail || body.message) || `HTTP ${response.status}`);
    }
    return body;
  }

  function node(tag, cls, text) {
    const value = document.createElement(tag);
    if (cls) value.className = cls;
    if (text !== undefined && text !== null) value.textContent = String(text);
    return value;
  }
  function feedback(text, state = '') {
    el.feedback.textContent = text || '';
    el.feedback.className = `brain-feedback ${state}`.trim();
  }
  function activeTopic() { return topics.find((topic) => topic.id === activeTopicId) || null; }
  function currentTopicId() { return el.topicSelect.value || activeTopicId || ''; }
  function updateChip(title) {
    if (!el.chip) return;
    el.chip.textContent = `Topic: ${title || 'none'}`;
    el.chip.title = title || 'No active topic';
  }
  function renderStatus(status, provider) {
    if (!status) {
      el.status.textContent = 'Local Brain status could not be read. Existing memory was not treated as empty.';
      el.status.className = 'brain-status bad';
      return;
    }
    const migration = status.migration || {};
    const migrationText = migration.state === 'empty' ? 'No legacy memory files were present to migrate'
      : migration.state === 'partial' || migration.state === 'blocked'
        ? `Migration needs attention (${(migration.warnings || []).length} warning(s))`
        : migration.state === 'complete' ? 'Available legacy imports verified as complete' : 'Migration status not yet recorded';
    const storageText = status.available
      ? `Local Brain available · ${status.topic_count || 0} topics · ${status.open_task_count || 0} open tasks · ${status.research_count || 0} sourced research record(s)`
      : `Local Brain unavailable (${status.storage_error || 'storage error'}); existing files were left untouched`;
    const providerText = provider
      ? provider.present ? `Gemini key configured (${provider.model || 'model not reported'}); provider ${providerTestText}` : 'Gemini key not configured'
      : 'Gemini configuration not checked';
    const warnings = Array.isArray(status.migration_warnings) && status.migration_warnings.length
      ? ` · ${status.migration_warnings.slice(0, 2).join(' ')}` : '';
    el.status.textContent = `${storageText}. Schema ${status.schema_version || 'unknown'}; ${migrationText}. ${providerText}.${warnings}`;
    el.status.className = status.available ? 'brain-status ok' : 'brain-status bad';
  }
  function renderTopics() {
    const preferred = selectedTopicId || activeTopicId || el.topicSelect.value;
    el.topicSelect.textContent = '';
    el.topicSelect.appendChild(node('option', '', topics.length ? 'Choose a saved topic' : 'No saved topics'));
    el.topicSelect.options[0].value = '';
    topics.forEach((topic) => {
      const option = node('option', '', `${topic.title} · ${topic.status}`);
      option.value = topic.id;
      el.topicSelect.appendChild(option);
    });
    if (preferred && topics.some((topic) => topic.id === preferred)) el.topicSelect.value = preferred;
    else if (activeTopicId) el.topicSelect.value = activeTopicId;
    selectedTopicId = el.topicSelect.value;
    renderSelectedTopic();
    updateChip(activeTopic()?.title || '');
  }
  function renderSelectedTopic() {
    const topic = topics.find((item) => item.id === el.topicSelect.value);
    el.topicGoal.value = topic ? topic.goal || '' : '';
    el.topicSummary.value = topic ? topic.summary || '' : '';
    el.topicNext.value = topic ? topic.next_step || '' : '';
    el.topicStatus.value = topic ? topic.status || 'paused' : 'active';
  }
  function renderMemories(rows) {
    el.memoryList.textContent = '';
    if (!rows.length) { el.memoryList.appendChild(node('p', 'brain-empty', 'No matching active memories.')); return; }
    rows.forEach((memory) => {
      const card = node('article', 'brain-card');
      card.appendChild(node('strong', '', `${memory.category}/${memory.key}`));
      card.appendChild(node('p', '', memory.value));
      card.appendChild(node('small', '', `${memory.source || 'legacy'} · ${memory.updated || ''} · ${memory.topic_id ? 'topic-scoped' : 'global'}`));
      const actions = node('div', 'brain-card-actions');
      const correct = node('button', '', memory.sensitive ? 'Correct (withheld)' : 'Correct');
      correct.type = 'button';
      correct.disabled = Boolean(memory.sensitive);
      if (memory.sensitive) correct.title = 'Sensitive legacy value is withheld; forget it or restore an earlier backup instead.';
      correct.addEventListener('click', async () => {
        const value = window.prompt(`Correct ${memory.category}/${memory.key}:`, memory.value);
        if (value === null || !value.trim()) return;
        try {
          await api('/api/brain/memory', { method: 'PUT', body: {
            category: memory.category, key: memory.key, value: value.trim(), topic_id: memory.topic_id || '',
            reason: 'Owner correction in the Brain panel',
          }});
          feedback('Memory corrected; the previous value is retained as superseded history.', 'ok');
          await refresh();
        } catch (error) { feedback(`Could not correct memory: ${error.message}`, 'bad'); }
      });
      const forget = node('button', '', 'Forget…');
      forget.type = 'button';
      forget.addEventListener('click', async () => {
        if (!window.confirm(`Prepare to forget ${memory.category}/${memory.key}? No change happens until you approve the second step.`)) return;
        try {
          const request = await api('/api/brain/memory/forget', { method: 'POST', body: { id: memory.id, topic_id: memory.topic_id || '' } });
          const typed = window.prompt(`To remove ${request.subject}, type this one-time code within two minutes: ${request.code}`);
          if (typed !== request.code) { feedback('Forget approval was not completed. Nothing was changed.'); return; }
          await api('/api/brain/memory/forget/confirm', { method: 'POST', body: { code: request.code } });
          feedback(`Removed ${request.subject} from active memory. Recovery backups may still contain prior copies.`, 'ok');
          await refresh();
        } catch (error) { feedback(`Could not forget memory: ${error.message}`, 'bad'); }
      });
      actions.append(correct, forget);
      card.appendChild(actions);
      el.memoryList.appendChild(card);
    });
  }
  function renderDecisions(rows) {
    el.decisionList.textContent = '';
    if (!rows.length) { el.decisionList.appendChild(node('p', 'brain-empty', 'No saved decisions for this topic.')); return; }
    rows.forEach((decision) => {
      const card = node('article', 'brain-card');
      card.appendChild(node('p', '', decision.value || decision.decision || ''));
      card.appendChild(node('small', '', `${decision.status || 'current'} · ${decision.created_at || ''}${decision.reason ? ` · ${decision.reason}` : ''}`));
      if ((decision.status || 'current') === 'current') {
        const revise = node('button', '', 'Supersede…');
        revise.type = 'button';
        revise.addEventListener('click', async () => {
          const value = window.prompt('Replace this decision with:', decision.value || decision.decision || '');
          if (value === null || !value.trim()) return;
          try {
            await api(`/api/brain/decisions/${encodeURIComponent(decision.id)}`, { method: 'PATCH', body: { decision: value.trim() } });
            feedback('New decision saved; the earlier decision is marked superseded.', 'ok');
            await refresh();
          } catch (error) { feedback(`Could not update decision: ${error.message}`, 'bad'); }
        });
        card.appendChild(revise);
      }
      el.decisionList.appendChild(card);
    });
  }
  function renderTasks(rows) {
    el.taskList.textContent = '';
    if (!rows.length) { el.taskList.appendChild(node('p', 'brain-empty', 'No open tasks for this topic.')); return; }
    rows.forEach((task) => {
      const card = node('article', 'brain-card');
      card.appendChild(node('p', '', task.value || task.title || ''));
      card.appendChild(node('small', '', `${task.status || 'open'}${task.due_at ? ` · due ${task.due_at}` : ''}${task.blocker ? ` · blocked: ${task.blocker}` : ''}`));
      if (task.status !== 'completed' && task.status !== 'cancelled') {
        const done = node('button', '', 'Mark complete');
        done.type = 'button';
        done.addEventListener('click', async () => {
          try {
            await api(`/api/brain/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { status: 'completed' } });
            feedback('Task marked complete.', 'ok');
            await refresh();
          } catch (error) { feedback(`Could not update task: ${error.message}`, 'bad'); }
        });
        card.appendChild(done);
      }
      el.taskList.appendChild(card);
    });
  }
  function safeLink(url, title) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      const link = node('a', '', title || parsed.hostname);
      link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      return link;
    } catch (_) { return null; }
  }
  function renderResearch(rows) {
    el.researchList.textContent = '';
    if (!rows.length) { el.researchList.appendChild(node('p', 'brain-empty', 'No owner-saved sourced research for this topic yet.')); return; }
    rows.forEach((record) => {
      const card = node('article', 'brain-card');
      card.appendChild(node('strong', '', record.query || record.subject || 'Saved research'));
      card.appendChild(node('p', '', record.value || record.answer || ''));
      card.appendChild(node('small', '', `${record.retrieved_at || ''} · ${record.verification || 'source verification not independently audited'}`));
      (Array.isArray(record.sources) ? record.sources : []).forEach((source, index) => {
        const link = safeLink(source.url, `[${index + 1}] ${source.title || source.url}`);
        if (link) card.appendChild(link);
      });
      el.researchList.appendChild(card);
    });
  }
  function resultValue(result, fallback) { return result.status === 'fulfilled' ? result.value : fallback; }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const topicId = currentTopicId();
    const query = el.memorySearch.value.trim();
    try {
      const results = await Promise.allSettled([
        api('/api/brain/status'), api('/api/brain/topics'),
        api(`/api/brain/memory?query=${encodeURIComponent(query)}&topic_id=${encodeURIComponent(topicId)}`),
        api(`/api/brain/decisions?topic_id=${encodeURIComponent(topicId)}`),
        api(`/api/brain/tasks?topic_id=${encodeURIComponent(topicId)}&status=open`),
        api(`/api/brain/research?topic_id=${encodeURIComponent(topicId)}&query=${encodeURIComponent(query)}`),
        api('/api/brain/backups'), api('/api/settings/gemini-key'),
      ]);
      const [statusResult, topicsResult, memoriesResult, decisionsResult, tasksResult, researchResult, backupsResult, providerResult] = results;
      const status = resultValue(statusResult, null);
      const topicData = resultValue(topicsResult, {});
      if (topicsResult.status === 'fulfilled') {
        topics = Array.isArray(topicData.topics) ? topicData.topics : [];
        activeTopicId = topicData.active_topic && topicData.active_topic.id || status?.active_topic?.id || '';
        renderTopics();
      } else {
        el.topicSelect.textContent = '';
        el.topicSelect.appendChild(node('option', '', 'Topics unavailable'));
        el.topicGoal.value = el.topicSummary.value = el.topicNext.value = '';
      }
      renderStatus(status, resultValue(providerResult, null));
      if (statusResult.status === 'rejected') {
        el.status.textContent = `Brain status could not be read (${statusResult.reason.message}). Existing memory was not treated as empty.`;
        el.status.className = 'brain-status bad';
      }
      renderMemories(resultValue(memoriesResult, { memories: [] }).memories || []);
      renderDecisions(resultValue(decisionsResult, { decisions: [] }).decisions || []);
      renderTasks(resultValue(tasksResult, { tasks: [] }).tasks || []);
      renderResearch(resultValue(researchResult, { research: [] }).research || []);
      const backupData = resultValue(backupsResult, { backups: [] });
      const available = (backupData.backups || []).filter((backup) => backup.verified);
      const previous = el.backupSelect.value;
      el.backupSelect.textContent = '';
      el.backupSelect.appendChild(node('option', '', available.length ? 'Choose verified backup' : 'No verified backups'));
      el.backupSelect.options[0].value = '';
      available.forEach((backup) => {
        const option = node('option', '', `${backup.created_at || backup.id} · ${backup.files} file(s) · ${backup.reason || 'backup'}`);
        option.value = backup.id;
        el.backupSelect.appendChild(option);
      });
      if (available.some((backup) => backup.id === previous)) el.backupSelect.value = previous;
      for (const [result, name] of [[memoriesResult, 'memory'], [decisionsResult, 'decisions'], [tasksResult, 'tasks'], [researchResult, 'research']] ) {
        if (result.status === 'rejected') feedback(`Could not load ${name}: ${result.reason.message}`, 'bad');
      }
    } catch (error) {
      el.status.textContent = `Brain controls could not refresh: ${error.message}. Existing memory was not treated as empty.`;
      el.status.className = 'brain-status bad';
    } finally { refreshing = false; }
  }

  el.topicSelect.addEventListener('change', () => { selectedTopicId = el.topicSelect.value; renderSelectedTopic(); void refresh(); });
  el.topicResume.addEventListener('click', async () => {
    const id = el.topicSelect.value;
    if (!id) { feedback('Choose a saved topic first.', 'bad'); return; }
    try {
      const result = await api(`/api/brain/topics/${encodeURIComponent(id)}/activate`, { method: 'POST', body: {} });
      activeTopicId = result.topic_id; selectedTopicId = result.topic_id;
      feedback(`Resumed ${result.topic_title}; earlier topic histories are retained.`, 'ok');
      updateChip(result.topic_title);
      await refresh();
    } catch (error) { feedback(`Could not resume topic: ${error.message}`, 'bad'); }
  });
  el.topicSave.addEventListener('click', async () => {
    const id = el.topicSelect.value;
    if (!id) { feedback('Choose a saved topic first.', 'bad'); return; }
    try {
      await api(`/api/brain/topics/${encodeURIComponent(id)}`, { method: 'PATCH', body: {
        goal: el.topicGoal.value, summary: el.topicSummary.value, next_step: el.topicNext.value, status: el.topicStatus.value,
      }});
      if (el.topicStatus.value === 'active') activeTopicId = id;
      feedback('Topic state saved locally.', 'ok');
      await refresh();
    } catch (error) { feedback(`Could not save topic state: ${error.message}`, 'bad'); }
  });
  el.topicCreate.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = el.topicTitle.value.trim();
    if (!title) return;
    try {
      const result = await api('/api/brain/topics', { method: 'POST', body: { title } });
      activeTopicId = result.topic_id; selectedTopicId = result.topic_id;
      el.topicTitle.value = '';
      feedback(`Created and activated topic: ${result.topic_title}.`, 'ok');
      updateChip(result.topic_title);
      await refresh();
    } catch (error) { feedback(`Could not create topic: ${error.message}`, 'bad'); }
  });
  el.memorySearchGo.addEventListener('click', () => void refresh());
  el.memorySearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void refresh(); } });
  el.memoryCreate.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/brain/memory', { method: 'POST', body: {
        category: el.memoryCategory.value, key: el.memoryKey.value.trim(), value: el.memoryValue.value.trim(),
        topic_id: el.memoryCategory.value === 'projects' ? currentTopicId() : '',
        provenance: 'Added explicitly by the owner in the Brain panel',
      }});
      el.memoryKey.value = ''; el.memoryValue.value = '';
      feedback('Memory saved locally.', 'ok');
      await refresh();
    } catch (error) { feedback(`Could not save memory: ${error.message}`, 'bad'); }
  });
  el.decisionCreate.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/brain/decisions', { method: 'POST', body: { topic_id: currentTopicId(), decision: el.decisionValue.value.trim() } });
      el.decisionValue.value = '';
      feedback('Decision saved to the selected topic.', 'ok');
      await refresh();
    } catch (error) { feedback(`Could not save decision: ${error.message}`, 'bad'); }
  });
  el.taskCreate.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/brain/tasks', { method: 'POST', body: { topic_id: currentTopicId(), title: el.taskTitle.value.trim() } });
      el.taskTitle.value = '';
      feedback('Task saved to the selected topic.', 'ok');
      await refresh();
    } catch (error) { feedback(`Could not save task: ${error.message}`, 'bad'); }
  });
  el.providerTest.addEventListener('click', async () => {
    el.providerTest.disabled = true;
    feedback('Testing Gemini with a real provider request; this uses the configured model and may count against its budget…');
    try {
      const result = await api('/api/brain-check');
      if (!result || !result.ok) throw new Error(result && (result.error || result.message) || 'The provider did not return a successful check.');
      providerTestText = `verified at ${result.model || 'reported model'} in ${result.latencyMs || '?'} ms`;
      feedback(`Gemini returned the expected test response from ${result.model || 'the configured model'}.`, 'ok');
    } catch (error) {
      providerTestText = `last test failed: ${error.message}`;
      feedback(`Gemini test failed: ${error.message}`, 'bad');
    } finally { el.providerTest.disabled = false; await refresh(); }
  });
  el.backup.addEventListener('click', async () => {
    el.backup.disabled = true;
    try {
      const result = await api('/api/brain/backup', { method: 'POST', body: {} });
      feedback(result.created
        ? `Verified local backup set created: ${result.files.length} file(s), manifest ${result.id}.`
        : (result.reason || 'No memory files existed to back up.'), result.created ? 'ok' : '');
      await refresh();
    } catch (error) { feedback(`Backup failed: ${error.message}`, 'bad'); }
    finally { el.backup.disabled = false; }
  });
  el.restore.addEventListener('click', async () => {
    const id = el.backupSelect.value;
    if (!id) { feedback('Choose a verified backup set first.', 'bad'); return; }
    if (!window.confirm('Prepare to restore this backup? Current files will be protected by a fresh verified rollback backup.')) return;
    el.restore.disabled = true;
    try {
      const prepared = await api('/api/brain/restore/prepare', { method: 'POST', body: { id } });
      const typed = window.prompt(`This replaces local Brain files from ${prepared.backup.id}. Verify the file count (${prepared.backup.files}). Type ${prepared.code} to approve within two minutes:`);
      if (typed !== prepared.code) { feedback('Restore approval was not completed. No files were replaced.'); return; }
      const restored = await api('/api/brain/restore', { method: 'POST', body: { code: prepared.code } });
      activeTopicId = restored.active_topic && restored.active_topic.id || '';
      selectedTopicId = activeTopicId;
      feedback(`Restore completed from ${restored.backup_id}; verified rollback set ${restored.rollback_id} was retained.`, 'ok');
      await refresh();
    } catch (error) { feedback(`Restore failed: ${error.message}. Check the retained rollback set before retrying.`, 'bad'); }
    finally { el.restore.disabled = false; }
  });

  el.button && el.button.addEventListener('click', () => setTimeout(() => {
    if (el.panel.style.display !== 'none') void refresh();
  }, 0));
  window.addEventListener('jarvis:brain-topic', (event) => {
    const detail = event.detail || {};
    if (detail.topic_id) { activeTopicId = detail.topic_id; selectedTopicId = detail.topic_id; updateChip(detail.topic_title || ''); }
    if (el.panel.style.display !== 'none') void refresh();
  });
  window.addEventListener('jarvis:brain-refresh', () => { if (el.panel.style.display !== 'none') void refresh(); });
  const observer = new MutationObserver(() => { if (el.panel.style.display !== 'none') void refresh(); });
  observer.observe(el.panel, { attributes: true, attributeFilter: ['style'] });
  void refresh();
})();
