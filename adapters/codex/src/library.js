const $ = id => document.getElementById(id);
export function createLibrary({ view, list, readSettings, saveSettings, remove }) {
  let page = 'report', offset = 0, selected = new Map(), pending = [], generation = 0;
  $('pages').hidden = false;
  function show(next) {
    page = next; generation++;
    for (const [id, value] of [['answer-page', 'report'], ['library', 'reports'], ['settings', 'settings']]) $(id).hidden = page !== value;
    for (const value of ['report', 'reports', 'settings']) $('page-' + value).setAttribute('aria-current', page === value ? 'page' : 'false');
    $('share').hidden = page !== 'report'; $('live').hidden = page !== 'report';
    $('delete-confirm').hidden = true;
    if (page === 'reports') load();
    if (page === 'settings') settings();
  }
  function open(binding) { $('page-report').disabled = false; show('report'); view.bind(binding); }
  async function load() {
    const ticket = ++generation;
    selected.clear(); $('delete-selected').disabled = true; $('library-status').textContent = 'Загрузка…';
    try {
      const data = await list({ offset });
      if (ticket !== generation) return;
      if (offset && !data.reports.length) { offset = 0; return load(); }
      $('library-count').textContent = `${offset + (data.reports.length ? 1 : 0)}–${offset + data.reports.length} из ${data.total}`;
      $('library-prev').disabled = offset === 0; $('library-next').disabled = !data.hasMore;
      $('library-status').textContent = data.errors.length ? `Не удалось прочитать чатов: ${data.errors.length}. ${data.errors[0].error}` : data.reports.length ? '' : 'Отчётов пока нет.';
      $('report-list').replaceChildren(...data.reports.map(row => {
        const entry = document.createElement('div'); entry.className = 'report-entry';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `Выбрать ${row.label || row.turnId}`);
        const key = `${row.sessionId}:${row.turnId}`;
        checkbox.onchange = () => { if (checkbox.checked) selected.set(key, { sessionId: row.sessionId, turnId: row.turnId }); else selected.delete(key); $('delete-selected').disabled = !selected.size; };
        const button = document.createElement('button'); button.type = 'button'; button.className = 'report-open';
        const label = document.createElement('span'); label.textContent = row.label || `Ответ ${row.turnId.slice(0, 8)}`;
        const meta = document.createElement('small'); meta.textContent = `${new Date(row.at).toLocaleString('ru-RU')} · чат ${row.sessionId.slice(0, 8)} · ${row.totalTokens == null ? 'нет счётчиков' : row.totalTokens.toLocaleString('ru-RU') + ' токенов'}`;
        button.append(label, meta); button.onclick = () => open({ sessionId: row.sessionId, turnId: row.turnId });
        entry.append(checkbox, button); return entry;
      }));
    } catch (error) { if (ticket === generation) $('library-status').textContent = error.message; }
  }
  async function settings() {
    const ticket = generation;
    $('settings-status').textContent = 'Загрузка…'; $('settings-save').disabled = true;
    try {
      const data = await readSettings(); if (ticket !== generation) return;
      $('setting-view').value = data.reportView; $('setting-limits').checked = data.appendPlanLimits; $('setting-days').value = data.autoDeleteDays;
      $('settings-status').textContent = ''; $('settings-save').disabled = false;
    } catch (error) { if (ticket === generation) $('settings-status').textContent = error.message; }
  }
  for (const next of ['report', 'reports', 'settings']) $('page-' + next).onclick = () => show(next);
  $('library-refresh').onclick = load;
  $('library-prev').onclick = () => { offset = Math.max(0, offset - 50); load(); };
  $('library-next').onclick = () => { offset += 50; load(); };
  $('delete-selected').onclick = () => {
    pending = [...selected.values()]; $('delete-message').textContent = `Удалить отчётов: ${pending.length}? Журналы чатов Codex сохранятся.`;
    $('delete-confirm').hidden = false; $('confirm-delete').focus();
  };
  $('cancel-delete').onclick = () => { $('delete-confirm').hidden = true; $('delete-selected').focus(); };
  $('confirm-delete').onclick = async () => {
    $('confirm-delete').disabled = true;
    try { await remove(pending); $('delete-confirm').hidden = true; await load(); $('library-refresh').focus(); }
    catch (error) { $('library-status').textContent = error.message; }
    finally { $('confirm-delete').disabled = false; }
  };
  $('settings-form').onsubmit = async event => {
    event.preventDefault(); $('settings-save').disabled = true;
    try {
      await saveSettings({ reportView: $('setting-view').value, appendPlanLimits: $('setting-limits').checked, autoDeleteDays: Number($('setting-days').value) });
      $('settings-status').textContent = 'Настройки сохранены.';
    } catch (error) { $('settings-status').textContent = error.message; }
    finally { $('settings-save').disabled = false; }
  };
  return { open, show };
}
