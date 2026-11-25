// Клеванты — анонимная статистика. Cloudflare Worker + D1 (привязка DB), секрет ADMIN_KEY.
// POST /e — события из игры (случайный id устройства, без личных данных, IP не хранится).
// GET /flags — общие переключатели игры (например, kab — личный кабинет для всех); POST /flags {key, k, v} — изменить (ADMIN_KEY).
// GET /stats?key=ADMIN_KEY — сводка: возвраты, прыжки за заход, где бросают; v205 — площадки (Танай / ДЗ-2), нарушения, купола, настройки, кадры/с, ошибки, версии.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const TZ = 7; // Кемерово, UTC+7: «день» считаем по местному времени Таная
const day = ms => new Date(ms + TZ * 3600e3).toISOString().slice(0, 10);
const TYPES = new Set(['open', 'jump', 'land', 'quit', 'hide', 'vr', 'cfg', 'perf', 'err', 'dz', 'unlock', 'sup', 'fs', 'inst']); // v464: + «поддержать проект», полный экран, установка // v205: + настройки, скорость кадров, ошибки, смена площадки
const DZN = { tanai: 'Танай', dz2: 'ДЗ-2 (в разработке)' };
const DZX = "COALESCE(json_extract(data,'$.z'),'tanai')"; // старые события без пометки — Танай

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/e' && req.method === 'POST') return ingest(req, env);
    if (url.pathname === '/flags') return flags(req, env); // v509: общие переключатели игры (GET — прочитать; POST {key,k,v} — изменить, только с ADMIN_KEY)
    if (url.pathname === '/stats') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('нет доступа', { status: 403 });
      return new Response(await stats(env, +url.searchParams.get('days') || 30), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('klevanta stats', { headers: CORS });
  }
};

async function ingest(req, env) {
  const txt = await req.text();
  if (txt.length > 30000) return new Response('too big', { status: 413, headers: CORS });
  let b; try { b = JSON.parse(txt) } catch { return new Response('bad', { status: 400, headers: CORS }) }
  const uid = String(b.u || ''), sid = String(b.s || '');
  if (!/^[a-z0-9]{6,16}$/.test(uid) || !/^[a-z0-9]{4,16}$/.test(sid)) return new Response('bad id', { status: 400, headers: CORS });
  const now = Date.now(), ev = Array.isArray(b.e) ? b.e.slice(0, 60) : [];
  const st = [env.DB.prepare('INSERT OR IGNORE INTO users(uid,first_day,plat,lang) VALUES(?,?,?,?)')
    .bind(uid, day(now), String(b.p || '').slice(0, 12), String(b.l || '').slice(0, 4))];
  for (const e of ev) {
    if (!Array.isArray(e)) continue;
    const t = String(e[1] || ''); if (!TYPES.has(t)) continue;
    const ts = Math.min(Math.max(+e[0] || now, now - 2 * 86400e3), now);
    st.push(env.DB.prepare('INSERT INTO events(ts,day,uid,sid,type,data,ver) VALUES(?,?,?,?,?,?,?)')
      .bind(ts, day(ts), uid, sid, t, JSON.stringify(e[2] ?? 0).slice(0, 700), String(b.v || '').slice(0, 10)));
  }
  await env.DB.batch(st);
  return new Response('ok', { headers: CORS });
}

const pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '—';
const esc = s => String(s ?? '—').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const table = (head, rows) => `<table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
const MODES = { brief: 'меню', fly: 'в полёте', done: 'экран результата', replay: 'повтор посадки', pause: 'пауза' };

async function stats(env, days) {
  const since = day(Date.now() - days * 86400e3), q = (s, ...a) => env.DB.prepare(s).bind(...a).all().then(r => r.results);
  const [daily, coh, jps, fun, quit, last, plat, grades, sess] = await Promise.all([
    q(`SELECT day, COUNT(DISTINCT uid) dau, COUNT(DISTINCT sid) ses, SUM(type='jump') j, SUM(type='land') l, SUM(type='sup') sup,
        (SELECT COUNT(*) FROM users u WHERE u.first_day=e.day) nw FROM events e WHERE day>=? GROUP BY day ORDER BY day DESC`, since),
    q(`SELECT first_day d, COUNT(*) n,
        SUM(EXISTS(SELECT 1 FROM events e WHERE e.uid=u.uid AND e.day=date(u.first_day,'+1 day'))) d1,
        SUM(EXISTS(SELECT 1 FROM events e WHERE e.uid=u.uid AND e.day=date(u.first_day,'+7 day'))) d7,
        SUM(EXISTS(SELECT 1 FROM events e WHERE e.uid=u.uid AND e.day>u.first_day AND e.day<=date(u.first_day,'+7 day'))) w1
       FROM users u WHERE first_day>=? GROUP BY first_day ORDER BY first_day DESC`, since),
    q(`SELECT CASE WHEN j>=10 THEN '10+' ELSE j END k, COUNT(*) n FROM
        (SELECT sid, SUM(type='jump') j FROM events WHERE day>=? GROUP BY sid) GROUP BY k ORDER BY MIN(j)`, since),
    q(`SELECT nw, COUNT(*) n, SUM(j>=1) j1, SUM(l>=1) l1, SUM(j>=2) j2, SUM(j>=5) j5, SUM(j>=10) j10 FROM
        (SELECT e.sid, MAX(e.day=u.first_day) nw, SUM(e.type='jump') j, SUM(e.type='land') l FROM events e JOIN users u ON u.uid=e.uid WHERE e.day>=? GROUP BY e.sid)
       GROUP BY nw ORDER BY nw DESC`, since),
    q(`SELECT m, COUNT(*) n, ROUND(AVG(s)) s FROM (SELECT json_extract(data,'$.m') m, json_extract(data,'$.s') s, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY ts DESC) rn FROM events WHERE type IN ('quit','hide') AND day>=?) WHERE rn=1 GROUP BY m ORDER BY n DESC`, since),
    q(`SELECT g, COUNT(*) n FROM (SELECT json_extract(data,'$.g') g, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY ts DESC) rn FROM events WHERE type='land' AND day>=?) WHERE rn=1 GROUP BY g ORDER BY n DESC`, since),
    q(`SELECT plat, COUNT(*) n FROM users WHERE first_day>=? GROUP BY plat ORDER BY n DESC`, since),
    q(`SELECT json_extract(data,'$.g') g, COUNT(*) n FROM events WHERE type='land' AND day>=? GROUP BY g ORDER BY n DESC`, since),
    q(`SELECT ROUND(AVG(s)) avg, COUNT(*) n FROM (SELECT MAX(json_extract(data,'$.s')) s FROM events WHERE type IN ('quit','hide') AND day>=? GROUP BY sid)`, since)
  ]);
  // v205: площадки — сравнение Таная и ДЗ-2
  const [cmp, grz, kinds, viol, cans, cfg, perf, errs, vers, dzsw, vr] = await Promise.all([
    q(`SELECT ${DZX} z, COUNT(DISTINCT uid) u, COUNT(DISTINCT sid) s, SUM(type='jump') j, SUM(type='land') l,
        SUM(type='land' AND json_extract(data,'$.g') IN ('ОТЛИЧНО','ХОРОШО')) good, SUM(type='land' AND json_extract(data,'$.iz')=1) iz,
        SUM(type='land' AND json_extract(data,'$.f')=1) fall, SUM(type='land' AND (json_extract(data,'$.hurt')=1 OR json_extract(data,'$.g')='ТРАВМА')) hurt,
        ROUND(AVG(CASE WHEN type='land' THEN json_extract(data,'$.d') END),1) d, ROUND(AVG(CASE WHEN type='land' THEN json_extract(data,'$.vs') END),1) vs,
        ROUND(AVG(CASE WHEN type='land' THEN json_extract(data,'$.w') END),1) w, ROUND(AVG(CASE WHEN type='land' THEN json_extract(data,'$.dur') END)) dur,
        SUM(type='land' AND COALESCE(json_extract(data,'$.low'),'')<>'') low, SUM(type='land' AND json_extract(data,'$.vs') IS NOT NULL) ln
       FROM events WHERE day>=? GROUP BY z ORDER BY z DESC`, since),
    q(`SELECT ${DZX} z, json_extract(data,'$.g') g, COUNT(*) n FROM events WHERE type='land' AND day>=? GROUP BY z,g ORDER BY z DESC, n DESC`, since),
    q(`SELECT ${DZX} z, json_extract(data,'$.k') k, COUNT(*) n FROM events WHERE type='land' AND day>=? GROUP BY z,k ORDER BY z DESC, n DESC`, since),
    q(`SELECT ${DZX} z, SUM(json_extract(data,'$.low') LIKE '%rwy%') rwy, SUM(json_extract(data,'$.low') LIKE '%nofly%') nofly, SUM(json_extract(data,'$.low') LIKE '%brk%') brk,
        SUM(json_extract(data,'$.low') LIKE '%spir%') spir, SUM(json_extract(data,'$.low') LIKE '%base%') base, SUM(json_extract(data,'$.sp')>0) sp, SUM(json_extract(data,'$.bt')>1.75) bt, SUM(json_extract(data,'$.vs') IS NOT NULL) n
       FROM events WHERE type='land' AND day>=? GROUP BY z ORDER BY z DESC`, since),
    q(`SELECT ${DZX} z, json_extract(data,'$.a') a, COUNT(*) n, SUM(json_extract(data,'$.f')=1) f, ROUND(AVG(json_extract(data,'$.d')),1) d FROM events WHERE type='land' AND day>=? GROUP BY z,a ORDER BY z DESC, a DESC`, since),
    q(`WITH L AS (SELECT json_extract(data,'$.ua') ua, json_extract(data,'$.uw') uw, json_extract(data,'$.cv') cv, json_extract(data,'$.gq') gq, json_extract(data,'$.wind') wind,
        ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ts DESC) rn FROM events WHERE type='cfg' AND day>=?)
       SELECT k, v, COUNT(*) n FROM (SELECT 'единицы' k, ua v FROM L WHERE rn=1 UNION ALL SELECT 'ветер в', uw FROM L WHERE rn=1 UNION ALL SELECT 'камера', cv FROM L WHERE rn=1
        UNION ALL SELECT 'графика', gq FROM L WHERE rn=1 UNION ALL SELECT 'ветер', wind FROM L WHERE rn=1) GROUP BY k, v ORDER BY k, n DESC`, since),
    q(`SELECT u.plat p, json_extract(e.data,'$.gq') gq, COUNT(*) n, ROUND(AVG(json_extract(e.data,'$.fps'))) fps, MIN(json_extract(e.data,'$.fps')) mn FROM events e JOIN users u ON u.uid=e.uid WHERE e.type='perf' AND e.day>=? GROUP BY p, gq ORDER BY n DESC`, since),
    q(`SELECT json_extract(data,'$.msg') msg, json_extract(data,'$.src') src, COUNT(*) n, COUNT(DISTINCT uid) u, MAX(ver) v FROM events WHERE type='err' AND day>=? GROUP BY msg, src ORDER BY n DESC LIMIT 15`, since),
    q(`SELECT ver, COUNT(DISTINCT sid) s, COUNT(DISTINCT uid) u FROM events WHERE day>=? GROUP BY ver ORDER BY s DESC LIMIT 12`, since),
    q(`SELECT SUM(type='unlock') un, SUM(type='dz' AND json_extract(data,'$.to')='dz2') to2, SUM(type='dz' AND json_extract(data,'$.to')='tanai') to1, COUNT(DISTINCT CASE WHEN type='unlock' THEN uid END) uu FROM events WHERE day>=?`, since),
    q(`SELECT COUNT(*) n, COUNT(DISTINCT uid) u FROM events WHERE type='vr' AND day>=?`, since)
  ]);
  // итог только по «дозревшим» дням: возврат на след. день — если тот день уже прошёл, на 7-й — если прошла неделя
  const today = day(Date.now()), ago = n => day(Date.now() - n * 86400e3), ok1 = r => r.d < today, ok7 = r => r.d <= ago(7);
  const [src, frm, sup, supd, fsi] = await Promise.all([
    q(`SELECT COALESCE(json_extract(o.data,'$.os'),'—') os, COALESCE(json_extract(o.data,'$.br'),'—') br, COUNT(DISTINCT o.uid) u, COUNT(DISTINCT o.sid) s, SUM(COALESCE(x.j,0)) j, SUM(COALESCE(x.j,0)>0) s1
       FROM events o LEFT JOIN (SELECT sid, SUM(type='jump') j FROM events WHERE day>=? GROUP BY sid) x ON x.sid=o.sid
       WHERE o.type='open' AND o.day>=? AND json_extract(o.data,'$.os') IS NOT NULL GROUP BY os, br ORDER BY u DESC`, since, since),
    q(`SELECT json_extract(data,'$.from') f, COUNT(DISTINCT uid) u, COUNT(DISTINCT sid) s FROM events WHERE type='open' AND day>=? AND json_extract(data,'$.from') IS NOT NULL GROUP BY f ORDER BY u DESC`, since),
    q(`SELECT COUNT(*) n, COUNT(DISTINCT uid) u FROM events WHERE type='sup' AND day>=?`, since),
    q(`SELECT COALESCE(json_extract(data,'$.os'),'—') os, COALESCE(json_extract(data,'$.br'),'—') br, COUNT(*) n, COUNT(DISTINCT uid) u FROM events WHERE type='sup' AND day>=? GROUP BY os, br ORDER BY n DESC`, since),
    q(`SELECT type t, COALESCE(json_extract(data,'$.a'),'—') a, COUNT(*) n, COUNT(DISTINCT uid) u FROM events WHERE type IN ('fs','inst') AND day>=? GROUP BY t, a ORDER BY t, n DESC`, since),
  ]); // v464: откуда открывают, «поддержать проект», полный экран и установка
  const OSN = { android: 'Android', ios: 'iPhone/iPad', desktop: 'компьютер' }, BRN = { ig: 'Instagram', fb: 'Facebook', tg: 'Telegram', vk: 'VK', safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge', samsung: 'Samsung', yandex: 'Яндекс', app: 'с иконки (приложение)', other: 'другой' };
  const FSA = { 'fs/auto': 'полный экран — сам при первом касании', 'fs/btn': 'полный экран — кнопкой', 'inst/show': 'подсказка «установи» показана', 'inst/btn': 'нажали «Установить» в подсказке', 'inst/how': 'нажали «Как» в подсказке', 'inst/menu': 'кнопка «Установить» в настройках', 'inst/done': 'установили (Android)' };
  const T = coh.reduce((a, r) => ({ n: a.n + r.n, n1: a.n1 + (ok1(r) ? r.n : 0), d1: a.d1 + (ok1(r) ? r.d1 : 0), n7: a.n7 + (ok7(r) ? r.n : 0), d7: a.d7 + (ok7(r) ? r.d7 : 0), w1: a.w1 + (ok7(r) ? r.w1 : 0) }), { n: 0, n1: 0, d1: 0, n7: 0, d7: 0, w1: 0 });
  const allS = jps.reduce((a, r) => a + r.n, 0), lastG = last.reduce((a, r) => a + r.n, 0), qn = quit.reduce((a, r) => a + r.n, 0);
  const fn = r => [r.nw ? 'первый день игрока' : 'вернувшиеся', r.n, pct(r.j1, r.n), pct(r.l1, r.n), pct(r.j2, r.n), pct(r.j5, r.n), pct(r.j10, r.n)];
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Клеванты — статистика</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;background:#f6f7f8;color:#1b1d21}h1{font-size:20px}h2{font-size:16px;margin:26px 0 6px}p.n{color:#666;margin:2px 0 8px;font-size:13px}
table{border-collapse:collapse;background:#fff;font-size:14px;margin-bottom:6px;max-width:100%}th,td{padding:5px 10px;border-bottom:1px solid #e3e5e8;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#eef0f2;font-weight:600}
.k{display:flex;flex-wrap:wrap;gap:10px}.k div{background:#fff;border-radius:10px;padding:10px 14px;min-width:120px}.k b{display:block;font-size:22px}
@media(prefers-color-scheme:dark){body{background:#15171a;color:#e8eaed}table,.k div{background:#1f2226}th{background:#2a2e33}th,td{border-color:#2f3338}p.n{color:#9aa0a6}}</style>
<h1>Клеванты — статистика за ${days} дн.</h1>
<div class=k><div><b>${T.n}</b>новых игроков</div><div><b>${pct(T.d1, T.n1)}</b>вернулись на след. день</div><div><b>${pct(T.d7, T.n7)}</b>вернулись на 7-й день</div><div><b>${pct(T.w1, T.n7)}</b>вернулись в течение недели</div><div><b>${sess[0]?.avg ? Math.round(sess[0].avg / 60 * 10) / 10 + ' мин' : '—'}</b>средний заход</div></div>
<p class=n>«…» — день ещё не наступил. Норма для браузерных игр: 20–30% на следующий день, 5–10% на 7-й день. Свежие дни ещё не «дозрели»: возврат на 7-й день виден только через неделю.</p>
<h2>Откуда открывают</h2><p class=n>С версии 464: система и браузер по строке браузера (Instagram, Telegram, Facebook, VK определяются по своей подписи). «Заходов с прыжком» — доля заходов, дошедших хотя бы до одного прыжка.</p>${src.length ? table(['система', 'браузер', 'игроков', 'заходов', 'заходов с прыжком', 'прыжков'], src.map(r => [OSN[r.os] || r.os, BRN[r.br] || r.br, r.u, r.s, pct(r.s1, r.s), r.j])) : '<p class=n>Пока нет данных.</p>'}
${frm.length ? '<p class=n>Метка в ссылке (?from=…):</p>' + table(['метка', 'игроков', 'заходов'], frm.map(r => [r.f, r.u, r.s])) : ''}
<h2>«Поддержать проект»</h2><p class=n>Нажатий: <b>${sup[0]?.n || 0}</b> (${sup[0]?.u || 0} устройств). По дням — в таблице «По дням».</p>${supd.length ? table(['система', 'браузер', 'нажатий', 'устройств'], supd.map(r => [OSN[r.os] || r.os, BRN[r.br] || r.br, r.n, r.u])) : ''}
<h2>Полный экран и установка</h2>${fsi.length ? table(['что', 'раз', 'устройств'], fsi.map(r => [FSA[r.t + '/' + r.a] || r.t + '/' + r.a, r.n, r.u])) : '<p class=n>Пока нет данных.</p>'}
<h2>Площадки: Танай и ДЗ-2</h2><p class=n>Каждое событие с версии 205 помечено площадкой; более ранние считаются Танаем. «Чисто» — ОТЛИЧНО или ХОРОШО. Нарушения — пересёк ВПП низко, над постройками, висел на клевантах / спираль над основной, база студента над основной.</p>
${table(['площадка', 'игроков', 'заходов', 'прыжков', 'посадок', 'чисто', 'в своей зоне', 'падения', 'травмы', 'промах, м', 'верт. скорость, м/с', 'ветер, м/с', 'полёт, с', 'нарушения'],
  cmp.map(r => [DZN[r.z] || r.z, r.u, r.s, r.j, r.l, pct(r.good, r.l), pct(r.iz, r.ln), pct(r.fall, r.l), pct(r.hurt, r.l), r.d, r.vs, r.w, r.dur, pct(r.low, r.ln)]))}
<p class=n>Пароль к ДЗ-2 вводили: ${dzsw[0]?.un || 0} раз (${dzsw[0]?.uu || 0} устройств); переключались на ДЗ-2 — ${dzsw[0]?.to2 || 0}, обратно на Танай — ${dzsw[0]?.to1 || 0}.</p>
<h2>Оценки по площадкам</h2>${table(['площадка', 'оценка', 'посадок'], grz.map(r => [DZN[r.z] || r.z, r.g, r.n]))}
<h2>Как встречают землю</h2><p class=n>run — пробежал, sit — сел на пятую точку, side — завал на бок, fallF — кувырок вперёд.</p>${table(['площадка', 'как', 'посадок'], kinds.map(r => [DZN[r.z] || r.z, r.k, r.n]))}
<h2>Нарушения правил</h2><p class=n>Доля от посадок с подробными данными (версия 205+).</p>${table(['площадка', 'ВПП низко', 'над постройками', 'висел на клевантах', 'спираль над основной', 'база над основной', 'спирали', 'разворот >100°'], viol.map(r => [DZN[r.z] || r.z, pct(r.rwy, r.n), pct(r.nofly, r.n), pct(r.brk, r.n), pct(r.spir, r.n), pct(r.base, r.n), pct(r.sp, r.n), pct(r.bt, r.n)]))}
<h2>Купола</h2>${table(['площадка', 'купол, фт²', 'посадок', 'падений', 'промах, м'], cans.map(r => [DZN[r.z] || r.z, r.a, r.n, pct(r.f, r.n), r.d]))}
<h2>Настройки игроков</h2><p class=n>Последние настройки каждого устройства на входе.</p>${table(['что', 'значение', 'устройств'], cfg.map(r => [r.k, r.v, r.n]))}
<h2>Скорость кадров</h2><p class=n>Через 8 с после первого прыжка, замер 3 с.</p>${table(['платформа', 'графика', 'замеров', 'кадров/с, сред.', 'мин.'], perf.map(r => [r.p, r.gq, r.n, r.fps, r.mn]))}
<h2>Ошибки в игре</h2>${errs.length ? table(['ошибка', 'где', 'раз', 'устройств', 'версия'], errs.map(r => [r.msg, r.src, r.n, r.u, r.v])) : '<p class=n>Ошибок нет.</p>'}
<h2>Версии</h2>${table(['версия', 'заходов', 'устройств'], vers.map(r => [r.ver, r.s, r.u]))}
<p class=n>VR: ${vr[0]?.n || 0} входов (${vr[0]?.u || 0} устройств).</p>
<h2>Возвраты по дням первого входа</h2>${table(['первый вход', 'игроков', 'на след. день', 'на 7-й день', 'за неделю'], coh.map(r => [r.d, r.n, ok1(r) ? pct(r.d1, r.n) : '…', ok7(r) ? pct(r.d7, r.n) : '…', ok7(r) ? pct(r.w1, r.n) : '…']))}
<h2>Прыжков за заход</h2><p class=n>Заход — одно открытие игры (вкладка/приложение).</p>${table(['прыжков', 'заходов', 'доля'], jps.map(r => [r.k, r.n, pct(r.n, allS)]))}
<h2>Воронка захода</h2><p class=n>Доля заходов, дошедших до шага.</p>${table(['кто', 'заходов', '≥1 прыжок', 'долетел', '≥2 прыжка', '≥5', '≥10'], fun.map(fn))}
<h2>Где закрывают игру</h2>${table(['экран', 'раз', 'доля', 'заход длился, с'], quit.map(r => [MODES[r.m] || r.m, r.n, pct(r.n, qn), r.s]))}
<h2>Последний результат перед уходом</h2><p class=n>Чем закончился последний прыжок захода — бросают ли после провала.</p>${table(['оценка', 'заходов', 'доля'], last.map(r => [r.g, r.n, pct(r.n, lastG)]))}
<h2>Все посадки</h2>${table(['оценка', 'посадок'], grades.map(r => [r.g, r.n]))}
<h2>Платформы новых игроков</h2>${table(['платформа', 'игроков'], plat.map(r => [r.plat, r.n]))}
<h2>По дням</h2>${table(['день', 'игроков', 'новых', 'заходов', 'прыжков', 'посадок', '«поддержать»'], daily.map(r => [r.day, r.dau, r.nw, r.ses, r.j, r.l, r.sup]))}`;
}


// ---------- общие переключатели игры: таблица flags создаётся сама ----------
const FLAGS = new Set(['kab']); // kab — кнопка «Личный кабинет» для всех игроков
async function flags(req, env) {
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS flags(k TEXT PRIMARY KEY, v TEXT)').run();
  if (req.method === 'POST') {
    let b = {}; try { b = JSON.parse(await req.text() || '{}') } catch { }
    if (!env.ADMIN_KEY || b.key !== env.ADMIN_KEY) return J({ err: 'key' }, 403);
    if (!FLAGS.has(b.k)) return J({ err: 'flag' }, 400);
    await env.DB.prepare('INSERT OR REPLACE INTO flags(k,v) VALUES(?,?)').bind(b.k, String(b.v ? 1 : 0)).run();
  }
  const rows = (await env.DB.prepare('SELECT k,v FROM flags').all()).results, o = {};
  for (const r of rows) if (FLAGS.has(r.k)) o[r.k] = +r.v;
  return J(o);
}
