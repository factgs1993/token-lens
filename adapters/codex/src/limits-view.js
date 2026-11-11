const number = value => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const period = minutes => !minutes ? 'Окно лимита' : minutes % 1440 === 0 ? `${number(minutes / 1440)} дн.` : minutes % 60 === 0 ? `${number(minutes / 60)} ч` : `${number(minutes)} мин.`;
const plans = { plus: 'Plus', pro: 'Pro', free: 'Free', go: 'Go', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
function element(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
export function renderLimits(data, live) {
  const $ = id => document.getElementById(id);
  $('quota-title').textContent = live ? 'Лимиты аккаунта' : 'Лимиты аккаунта на момент сохранения';
  const pools = data?.pools || [], windows = pools.flatMap(pool => [pool.primary, pool.secondary].filter(Boolean));
  const plan = pools.map(pool => plans[pool.planType]).find(Boolean);
  $('quota-summary').textContent = windows.length
    ? `${plan ? plan + ' · ' : ''}${windows.map(w => `${period(w.windowMinutes)}: осталось ${number(w.remainingPercent)}%`).join(' · ')}${data.stale ? ' · устаревшие данные' : ''}`
    : data?.state === 'loading' && live ? 'Получаем данные аккаунта…' : 'Лимиты недоступны';
  const body = $('quota-windows'); body.replaceChildren();
  for (const pool of pools) {
    const group = element('section', null, 'quota-pool');
    group.append(element('h3', pool.name));
    for (const window of [pool.primary, pool.secondary].filter(Boolean)) {
      const row = element('div', null, 'quota-row');
      const label = `${period(window.windowMinutes)} · использовано ${number(window.usedPercent)}%`;
      const heading = element('div', null, 'quota-heading');
      heading.append(element('span', label), element('strong', `Осталось ${number(window.remainingPercent)}%`));
      const track = element('div', null, 'quota-track');
      track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label);
      track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.min(100, window.usedPercent)));
      track.setAttribute('aria-valuetext', `Использовано ${number(window.usedPercent)}%, осталось ${number(window.remainingPercent)}%`);
      const bar = element('span'); bar.style.width = `${Math.min(100, window.usedPercent)}%`; track.append(bar);
      row.append(heading, track);
      row.append(element('p', window.resetsAt ? `Сброс: ${new Date(window.resetsAt * 1000).toLocaleString('ru-RU')}` : 'Время сброса не передано.', 'muted'));
      group.append(row);
    }
    if (!pool.primary && !pool.secondary) group.append(element('p', 'Данные окон лимитов не переданы.', 'muted'));
    if (pool.reached) group.append(element('p', 'Сервис сообщил о достигнутом лимите аккаунта или рабочего пространства.', 'quota-warning'));
    body.append(group);
  }
  const notes = [];
  if (data?.ordinaryUsageAllowed === false) notes.push('Включённое использование сейчас недоступно по данным сервиса.');
  if (data?.error) notes.push(data.error);
  if (data?.stale) notes.push('Показаны последние полученные значения; они могли измениться.');
  if (data?.fetchedAt) notes.push(`${live ? 'Обновлено' : 'Снимок'}: ${new Date(data.fetchedAt).toLocaleString('ru-RU')}.${live ? ' Проверка раз в минуту.' : ''}`);
  if (!pools.length && data?.state === 'loading' && !live) notes.push('На момент сохранения данные лимитов ещё не были получены.');
  $('quota-status').textContent = notes.join(' ');
}
