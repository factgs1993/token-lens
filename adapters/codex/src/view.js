const $ = id => document.getElementById(id);
const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—';
const categories = [['schemas','Схемы инструментов','#ab9af5'],['tool_results','Результаты инструментов','#68bdea'],['instructions','Инструкции и каталог скиллов','#e2bd68'],['conversation','История, запрос и контекст','#79c9aa'],['tool_calls','Аргументы вызовов инструментов','#e4a17d']];
const states = { running: 'Ответ выполняется · данные пока неполные', completed: 'Ответ завершён', interrupted: 'Ответ прерван', unknown: 'Статус ответа не сохранён' };
function rows(target, items) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  target.replaceChildren();
  if (!total) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Нет данных в локальном журнале.'; target.append(p); return; }
  for (const item of items.filter(item => item.value > 0)) {
    const row = document.createElement('div'); row.className = 'row';
    const dot = document.createElement('i'); dot.style.background = item.color;
    const label = document.createElement('span'); label.className = 'label'; label.textContent = item.label;
    const value = document.createElement('strong'); value.textContent = `≈ ${number(item.value)}`;
    const track = document.createElement('div'); track.className = 'track';
    const bar = document.createElement('span'); bar.style.width = `${item.value / total * 100}%`; bar.style.background = item.color; track.append(bar);
    row.append(dot, label, value, track); target.append(row);
  }
}
export function createReportView({ getReport, openExternal, live = true }) {
  let binding, selected, data, baseUrl, loading = false, generation = 0;
  function route(endpoint) { return `${baseUrl}${endpoint}?${new URLSearchParams({ sessionId: binding.sessionId, turnId: selected })}`; }
  function render() {
    const turn = data.turns.find(turn => turn.id === selected);
    if (!turn) throw new Error('Ответ отсутствует в отчёте.');
    $('content').hidden = false; $('report').hidden = !turn.hasUsage;
    $('answer-title').textContent = turn.label || `Ответ ${turn.id.slice(0, 8)}`;
    $('status').textContent = `${states[turn.status] || states.unknown} · ${turn.requests.length} запросов модели${turn.hasUsage ? '' : ' · счётчики ещё не записаны'}`;
    $('prompt-title').textContent = turn.prompt ? `Запрос · ${number(turn.prompt.length)} символов${turn.prompt.truncated ? ' · превью до 200' : ''}` : 'Запрос · текст недоступен';
    $('prompt-preview').textContent = turn.prompt?.preview || 'Текст запроса не найден в локальном журнале этого хода.';
    $('return-answer').hidden = selected === binding.turnId;
    for (const [id, endpoint] of [['browser-report','/answer'],['download-html','/export.html'],['download-json','/export.json']]) {
      $(id).hidden = id !== 'download-json' && !baseUrl;
      $(id).href = baseUrl ? route(endpoint) : '#';
    }
    const s = data.summary;
    $('chat-total').textContent = number(s.totals?.total_tokens); $('chat-input').textContent = number(s.totals?.input_tokens); $('chat-output').textContent = number(s.totals?.output_tokens);
    $('chat-coverage').textContent = `Счётчики есть для ${s.measuredTurnCount} из ${s.turnCount} ходов. Без счётчиков: ${s.missingUsageTurns}. Выполняются: ${s.runningTurns}.${s.missingUsageTurns || s.runningTurns || data.malformedLines ? ' Итог может быть неполным.' : ''} Кэш и рассуждения повторно не прибавляются.`;
    $('turns').replaceChildren(...data.turns.map((row, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'turn'; button.dataset.turnId = row.id;
      button.setAttribute('aria-current', String(row.id === selected));
      const label = document.createElement('span'); label.textContent = `${index + 1}. ${row.label || row.id}`;
      const count = document.createElement('strong'); count.textContent = row.hasUsage ? number(row.usage.total_tokens) : 'Нет счётчиков';
      const info = document.createElement('small'); info.textContent = `${states[row.status] || states.unknown}${row.startedAt ? ' · ' + new Date(row.startedAt).toLocaleString('ru-RU') : ''}`;
      button.append(label, count, info); button.onclick = () => { selected = row.id; render(); }; return button;
    }));
    $('source').textContent = `Источник: ${data.source}. Чат: ${data.sessionId}. Ход: ${turn.id}. ${data.malformedLines ? `Пропущено повреждённых строк: ${data.malformedLines}. Итоги могут быть неполными.` : ''}`;
    if (!turn.hasUsage) return;
    const u = turn.usage;
    $('total').textContent = number(u.total_tokens); $('input').textContent = number(u.input_tokens); $('output').textContent = number(u.output_tokens);
    $('cached').textContent = `${number(u.cached_input_tokens)} из кэша · входит во вход`;
    $('reasoning').textContent = `${number(u.reasoning_output_tokens)} рассуждений · входит в выход`;
    const values = categories.map(([key, label, color]) => ({ label, color, value: turn.categories[key] || 0 }));
    rows($('categories'), values);
    $('stack').replaceChildren(...values.filter(item => item.value > 0).map(item => { const bar = document.createElement('span'); bar.style.flexGrow = item.value; bar.style.background = item.color; return bar; }));
    rows($('consumers'), Object.entries(turn.consumers).sort((a,b) => b[1] - a[1]).map(([label,value]) => ({label,value,color:'#68bdea'})));
    $('request-count').textContent = `${turn.requests.length} шагов`;
    $('requests').replaceChildren(...turn.requests.map((request,index) => {
      const row = document.createElement('tr'); const step = document.createElement('td'); step.textContent = `${index + 1} · ${request.model}`;
      const time = document.createElement('small'); time.textContent = new Date(request.at).toLocaleTimeString('ru-RU'); step.append(time); row.append(step);
      for (const value of [request.input_tokens, request.cached_input_tokens, request.output_tokens]) { const cell = document.createElement('td'); cell.textContent = number(value); row.append(cell); } return row;
    }));
  }
  for (const id of ['browser-report','download-html','download-json']) $(id).onclick = async event => {
    if (baseUrl) {
      if (openExternal) { event.preventDefault(); try { await openExternal($(id).href); } catch(error) { $('status').textContent = error.message; } }
      return;
    }
    event.preventDefault();
    if (id === 'download-json' && data) {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...data, turnId: selected }, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `token-lens-${data.sessionId}-${selected}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
  $('return-answer').onclick = () => { selected = binding.turnId; render(); };
  async function refresh() {
    if (!binding || loading) return;
    const ticket = generation; loading = true;
    try {
      const result = await getReport(binding);
      if (ticket !== generation) return;
      if (result.report.sessionId !== binding.sessionId || result.report.turnId !== binding.turnId) throw new Error('Отчёт относится к другому ответу.');
      data = result.report; baseUrl = result.baseUrl; render(); $('live').textContent = live ? 'Обновляется' : 'Сохранённый отчёт';
    } catch(error) { if (ticket === generation) { $('status').textContent = error.message; $('live').textContent = 'Ошибка'; } }
    finally { loading = false; }
  }
  if (live) setInterval(() => { if (!document.hidden) refresh(); }, 4000);
  return { bind(next) {
    if (binding?.sessionId === next.sessionId && binding?.turnId === next.turnId) return;
    binding = next; selected = next.turnId; generation++; $('content').hidden = true; refresh();
  }, refresh };
}
