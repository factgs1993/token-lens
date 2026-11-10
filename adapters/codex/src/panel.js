import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const $ = id => document.getElementById(id);
const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—';
const categories = [['schemas','Схемы инструментов','#ab9af5'],['tool_results','Результаты инструментов','#68bdea'],['instructions','Инструкции и каталог скиллов','#e2bd68'],['conversation','История, запрос и контекст','#79c9aa'],['tool_calls','Аргументы вызовов инструментов','#e4a17d']];
const app = new App({ name: 'codex-token-lens', version: '0.1.3' }, { availableDisplayModes: ['inline', 'fullscreen'] });
let binding = null;
let loading = false;
let connected = false;
let generation = 0;

function host(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.safeAreaInsets) for (const side of ['top','right','bottom','left']) document.documentElement.style.setProperty(`--safe-${side}`, `${context.safeAreaInsets[side] || 0}px`);
  const route = context?.['openai/deepLink']?.url;
  if (typeof route !== 'string') return;
  try {
    const url = new URL(route, 'https://token-lens.invalid');
    const sessionId = url.searchParams.get('sessionId');
    const turnId = url.searchParams.get('turnId');
    if(url.pathname !== '/answer' || ![sessionId,turnId].every(id=>/^[a-zA-Z0-9_-]{1,100}$/.test(id || ''))) throw new Error('Некорректная ссылка на ответ.');
    if(binding?.sessionId === sessionId && binding?.turnId === turnId) return;
    binding = {sessionId,turnId}; generation++; $('report').hidden=true;
    if(connected) refresh();
  } catch(error) { binding=null;$('status').textContent=error.message;$('report').hidden=true; }
}
function rows(target, items) {
  const total=items.reduce((sum,item)=>sum+item.value,0);
  target.replaceChildren();
  if(!total){const p=document.createElement('p');p.className='muted';p.textContent='Нет данных в локальном журнале.';target.append(p);return;}
  for(const item of items.filter(item=>item.value>0)){
    const row=document.createElement('div');row.className='row';
    const dot=document.createElement('i');dot.style.background=item.color;
    const label=document.createElement('span');label.className='label';label.textContent=item.label;
    const value=document.createElement('strong');value.textContent=`≈ ${number(item.value)}`;
    const track=document.createElement('div');track.className='track';
    const bar=document.createElement('span');bar.style.width=`${item.value/total*100}%`;bar.style.background=item.color;track.append(bar);
    row.append(dot,label,value,track);target.append(row);
  }
}
function render(data) {
  const turn=data.turn;
  $('report').hidden=!turn?.hasUsage;
  if(!turn) throw new Error('Ответ отсутствует в отчёте.');
  $('answer-title').textContent=turn.label || `Ответ ${turn.id.slice(0,8)}`;
  const states={running:'Ответ выполняется · данные пока неполные',completed:'Ответ завершён',interrupted:'Ответ прерван',unknown:'Статус ответа не сохранён'};
  $('status').textContent=`${states[turn.status]} · ${turn.requests.length} запросов модели`;
  if(!turn.hasUsage){$('status').textContent+=' · счётчики ещё не записаны';return;}
  const u=turn.usage;
  $('total').textContent=number(u.total_tokens);$('input').textContent=number(u.input_tokens);$('output').textContent=number(u.output_tokens);
  $('cached').textContent=`${number(u.cached_input_tokens)} из кэша · входит во вход`;
  $('reasoning').textContent=`${number(u.reasoning_output_tokens)} рассуждений · входит в выход`;
  const values=categories.map(([key,label,color])=>({label,color,value:turn.categories[key] || 0}));
  rows($('categories'),values);
  $('stack').replaceChildren(...values.filter(item=>item.value>0).map(item=>{const bar=document.createElement('span');bar.style.flexGrow=item.value;bar.style.background=item.color;return bar;}));
  rows($('consumers'),Object.entries(turn.consumers).sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value,color:'#68bdea'})));
  $('request-count').textContent=`${turn.requests.length} шагов`;
  $('requests').replaceChildren(...turn.requests.map((request,index)=>{
    const row=document.createElement('tr');const step=document.createElement('td');step.textContent=`${index+1} · ${request.model}`;
    const time=document.createElement('small');time.textContent=new Date(request.at).toLocaleTimeString('ru-RU');step.append(time);row.append(step);
    for(const value of [request.input_tokens,request.cached_input_tokens,request.output_tokens]){const cell=document.createElement('td');cell.textContent=number(value);row.append(cell);}return row;
  }));
  $('source').textContent=`Источник: ${data.source}. Чат: ${data.sessionId}. Ход: ${turn.id}. ${data.malformedLines ? `Пропущено повреждённых строк: ${data.malformedLines}. Итоги могут быть неполными.` : ''} Панель читает только локальные журналы; сетевых запросов нет.`;
}
async function refresh() {
  if(!binding || loading) return;
  loading=true;const ticket=generation;
  try{
    const result=await app.callServerTool({name:'read_token_usage',arguments:binding});
    if(ticket!==generation) return;
    if(result.isError) throw new Error(result.content?.find(c=>c.type==='text')?.text || 'Ошибка чтения журнала');
    render(result.structuredContent);$('live').textContent='Обновляется';
  }catch(error){if(ticket===generation){$('status').textContent=error.message;$('live').textContent='Ошибка';$('report').hidden=true;}}
  finally{loading=false;}
}
app.onhostcontextchanged=host;
await app.connect();connected=true;
host(app.getHostContext());
if(binding) refresh();
else{$('live').textContent='Готово';$('status').textContent='Откройте ссылку «📊 Токены этого ответа» в конце сообщения. Она привязана к конкретному ответу.';}
setInterval(()=>{if(!document.hidden) refresh();},4000);
