(function () {
  const R = window.Rules;
  const UNIT = (function () { try { return localStorage.getItem('miaoli-unit') === '3AB' ? '3AB' : '2A'; } catch (e) { return '2A'; } })();
  const KEY = UNIT === '3AB' ? 'miaoli-scheduler-3ab-v1' : 'miaoli-scheduler-2a-v1';
  // 單位設定：每班人數（硬性）、借調代碼、是否每班至少 1 位 N2 以上
  const CFG = UNIT === '3AB'
    ? { coverage: { D: { weekday: 7, off: 6 }, E: 5, N: 4 }, lend: '2A', lendLabel: '支援2A', requireSenior: true }
    : { coverage: { D: 1, E: 1, N: 1 }, lend: '3AB', lendLabel: '支援3AB', requireSenior: false };
  const LEVELS = ['N', 'N1', 'N2', 'N3', 'N4'];
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const BRUSHES = [
    { code: '班', label: '上班', cls: 'D' }, { code: '例', label: '例', cls: 'rest' }, { code: '休息', label: '休息', cls: 'rest' },
    { code: '休假', label: '休假', cls: 'leave' }, { code: '特休', label: '特休', cls: 'leave' }, { code: '補休', label: '補休', cls: 'rest' },
    { code: '國定', label: '國定', cls: 'rest' }, { code: '2A', label: '2A', cls: UNIT === '2A' ? 'D' : 'lend' }, { code: '3AB', label: '3AB', cls: UNIT === '3AB' ? 'D' : 'lend' }, { code: '公假', label: '公假', cls: 'leave' }, { code: '8-5', label: '8-5班', cls: 'adm' }, { code: '', label: '清除', cls: '' },
  ];
  const PREBOOK_BRUSHES = ['休假', '特休', ''];

  const now = new Date();
  const sample = () => ({
    year: now.getFullYear(), month: now.getMonth() + 1, requiredRest: 0, holidays: [], requestedAt: '',
    staff: [
      { id: 's1', name: '護士A', level: 'N2', shift: 'D', support: false, prevShift: '' },
      { id: 's2', name: '護士B', level: 'N2', shift: 'E', support: false, prevShift: '' },
      { id: 's3', name: '護士C', level: 'N3', shift: 'N', support: false, prevShift: '' },
      { id: 's4', name: '護士D', level: 'N2', shift: 'D', support: false, prevShift: '' },
      { id: 's5', name: '支援甲', level: 'N2', shift: 'N', support: true, prevShift: '' },
    ],
    cells: {}, prebook: {},
  });

  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || sample(); } catch (e) { S = sample(); }
  if (!S.holidays) S.holidays = [];
  if (!S.auto) S.auto = {};
  if (!S.supportMax && S.supportMax !== 0) S.supportMax = 6;
  if (!S.seed) S.seed = 1;
  const autoHolidays = () => window.Holidays.forMonth(S.year, S.month);
  if (!S.holidays.length) { S.holidays = autoHolidays(); S.requiredRest = 0; }
  const recalcRest = () => { S.requiredRest = R.redDays(S.year, S.month, S.holidays); };
  if (!S.requiredRest || !S.restManual) recalcRest(); // 沒有手動改過就依月份與假日重算，避免存到舊值
  let mode = 'schedule';
  let brush = '班';
  const $ = (id) => document.getElementById(id);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
  const nDays = () => R.daysInMonth(S.year, S.month);
  const store = () => (mode === 'schedule' ? S.cells : S.prebook);
  const rowOf = (id) => {
    const st = store();
    const n = nDays();
    if (!st[id]) st[id] = [];
    while (st[id].length < n) st[id].push('');
    return st[id];
  };

  function codeClass(c) {
    if (c === 'D' || c === 'E' || c === 'N') return c;
    if (c === '3AB' || c === '2A') return 'lend';
    if (c === '8-5') return 'adm';
    if (['例', '休息', '國定', '補國', '補休'].includes(c)) return 'rest';
    if (c) return 'leave';
    return '';
  }

  function renderBrushes() {
    const list = mode === 'schedule' ? BRUSHES : BRUSHES.filter((b) => PREBOOK_BRUSHES.includes(b.code));
    if (!list.some((b) => b.code === brush)) brush = list[0].code;
    $('brushes').innerHTML = '';
    list.forEach((b) => {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.className = (b.cls || '') + (b.code === brush ? ' on' : '');
      el.onclick = () => { brush = b.code; renderBrushes(); };
      $('brushes').appendChild(el);
    });
  }

  function issuesNow() {
    const params = { year: S.year, month: S.month, staff: S.staff, requiredRest: S.requiredRest, holidays: S.holidays, params: { coverage: CFG.coverage, requireSenior: CFG.requireSenior }, incoming: S.incoming, prebook: S.prebook };
    return mode === 'schedule'
      ? R.checkSchedule({ ...params, cells: S.cells })
      : R.checkPrebook({ ...params, requestedAt: S.requestedAt, prebook: S.prebook });
  }

  // 另一單位借給本單位的人：讀對方班表裡標了「本單位代碼」的日子，在本單位班表顯示成唯讀的支援列
  function borrowedFrom(O, target, recv) { // O 單位借給 target 單位的人
    if (!O || !O.staff || O.year !== S.year || O.month !== S.month) return [];
    const n = nDays(), out = [], from = target === '3AB' ? '2A' : '3AB';
    const used = {}; // 只顯示對方實際用到的人數（本單位該班該日 incoming 數）
    const inc = (recv && recv.incoming) || {};
    O.staff.forEach((p) => {
      if (p.extra) return;
      const r = (O.cells && O.cells[p.id]) || [];
      const days = [];
      for (let d = 1; d <= n; d++) if (r[d - 1] === target) {
        const key = p.shift + d, cap = ((inc[p.shift] || [])[d - 1]) || 0;
        if ((used[key] || 0) < cap) { used[key] = (used[key] || 0) + 1; days.push(d); }
      }
      if (days.length) out.push({ id: p.id, name: p.name, level: p.level, shift: p.shift, from, days });
    });
    return out;
  }
  const loadOther = () => { try { return JSON.parse(localStorage.getItem(UNIT === '3AB' ? 'miaoli-scheduler-2a-v1' : 'miaoli-scheduler-3ab-v1')); } catch (e) { return null; } };
  function borrowedRows() { return borrowedFrom(loadOther(), UNIT, S); }

  function renderGrid(issues) {
    const n = nDays();
    const bad = new Set(issues.filter((i) => i.staffId && i.day).map((i) => i.staffId + ':' + i.day));
    const g = $('grid');
    let h = '<tr><th class="name">人員</th>';
    for (let d = 1; d <= n; d++) {
      const w = R.dow(S.year, S.month, d);
      h += `<th class="${w === 0 || w === 6 ? 'we' : ''}">${d}<br>${WD[w]}</th>`;
    }
    h += '</tr>';
    S.staff.forEach((p) => {
      const r = rowOf(p.id);
      h += `<tr><td class="name">${esc(p.name)}<div class="small">${p.level} ${p.shift}${p.support ? ' 支援' : ''}${p.lendable ? (UNIT === '3AB' ? ' 可支2A' : ' 可支3AB') : ''}${p.extra ? ' 特約' : ''}</div></td>`;
      for (let d = 1; d <= n; d++) {
        const w = R.dow(S.year, S.month, d);
        const c = r[d - 1];
        const isAuto = mode === 'schedule' && S.auto[p.id] && S.auto[p.id][d - 1];
        h += `<td class="c ${codeClass(c)} ${w === 0 || w === 6 ? 'we' : ''} ${bad.has(p.id + ':' + d) ? 'bad' : ''} ${isAuto === 2 ? 'pre' : isAuto ? 'auto' : ''}" data-id="${p.id}" data-d="${d}">${c}</td>`;
      }
      h += '</tr>';
    });
    const borrowed = mode === 'schedule' ? borrowedRows() : [];
    borrowed.forEach((p) => {
      h += `<tr class="borrowed"><td class="name">${esc(p.name)}<div class="small">${p.level} ${p.shift} ←${p.from}</div></td>`;
      for (let d = 1; d <= n; d++) {
        const w = R.dow(S.year, S.month, d);
        const on = p.days.includes(d);
        h += `<td class="${on ? 'bor ' + p.shift : ''} ${w === 0 || w === 6 ? 'we' : ''}" style="${on ? 'background:#e8f0ff;font-weight:700' : ''}">${on ? p.shift : ''}</td>`;
      }
      h += '</tr>';
    });
    if (mode === 'schedule') {
      const lab = { D: '白', E: '小', N: '大' };
      ['D', 'E', 'N'].forEach((s) => {
        h += `<tr><td class="name">${lab[s]}班人數</td>`;
        for (let d = 1; d <= n; d++) {
          const c = S.staff.filter((p) => rowOf(p.id)[d - 1] === s).length + borrowed.filter((p) => p.days.includes(d) && p.shift === s).length;
          const need = R.coverageNeed(CFG.coverage, s, S.year, S.month, d, S.holidays);
          h += `<td class="cnt ${c >= need && c <= need + 1 ? 'good' : 'bad'}">${c}</td>`;
        }
        h += '</tr>';
      });
    }
    g.innerHTML = h;
    g.querySelectorAll('td.c').forEach((td) => {
      td.onclick = () => {
        const p = S.staff.find((x) => x.id === td.dataset.id);
        const r = rowOf(p.id);
        r[td.dataset.d - 1] = brush === '班' || brush === UNIT ? p.shift : brush; // 本單位的畫筆＝在本單位上原班別；另一單位＝借調
        if (mode === 'schedule' && S.auto[p.id]) S.auto[p.id][td.dataset.d - 1] = false;
        save(); render();
      };
    });
  }

  function renderRestStats() {
    const el = $('restStats'); if (!el) return;
    const n = nDays(), hol = new Set(S.holidays || []);
    const list = (a) => (a.length ? a.join('、') : '—');
    let h = '<tr><th class="name">姓名</th><th>實休／應休</th><th>週休（六日）</th><th>國定休</th></tr>';
    let mn = 99, mx = -1;
    S.staff.forEach((p) => {
      const r = rowOf(p.id);
      const rests = []; for (let d = 1; d <= n; d++) if (R.MONTH_REST.includes(r[d - 1])) rests.push(d);
      const want = p.extra ? (p.restDays != null ? p.restDays : null) : S.requiredRest; // 應休＝當月標準天數
      if (!p.extra) { mn = Math.min(mn, rests.length); mx = Math.max(mx, rests.length); }
      const wk = rests.filter((d) => { const w = R.dow(S.year, S.month, d); return (w === 0 || w === 6) && !hol.has(d); });
      const gd = rests.filter((d) => hol.has(d));
      const cut = !p.extra && rests.length < S.requiredRest, less = !p.extra && p.restDays != null ? rests.length < p.restDays : false;
      h += `<tr><td class="name">${esc(p.name)}<div class="small">${p.level} ${p.shift}${p.extra ? ' 特約' : ''}</div></td><td style="${less ? 'color:#b91c1c;font-weight:700' : cut ? 'color:#b45309;font-weight:700' : ''}">${rests.length}${want != null ? ' / ' + want : ''}${cut ? '<div class="small">少休 ' + (S.requiredRest - rests.length) + ' 天（人力不足）</div>' : ''}</td><td style="text-align:left">${wk.length}日：${list(wk)}</td><td style="text-align:left">${gd.length}日：${list(gd)}</td></tr>`;
    });
    if (mx >= 0 && mx - mn > 2) h += `<tr><td colspan="4" class="small" style="color:#b91c1c">各人實休最多差 ${mx - mn} 天，超過 2 天，建議重新排班。</td></tr>`;
    el.innerHTML = h;
  }

  function renderIssues(issues) {
    const el = $('issues');
    if (!issues.length) { el.innerHTML = '<div class="ok">目前沒有違反規則。</div>'; return; }
    const by = {};
    issues.forEach((i) => (by[i.rule] = (by[i.rule] || 0) + 1));
    const names = { coverage: '每班人數', 'pure-shift': '班別混用', boundary: '換班別交界', biweekly: '每2週例假', fourweek: '每4週休息', consecutive: '連續上班',
      'monthly-rest': '本月應休', 'support-level': '支援職級', 'prebook-deadline': '預假截止', 'prebook-weekend': '預假六日', 'prebook-total': '預假總數' };
    let h = `<div class="small">共 ${issues.length} 項：` + Object.keys(by).map((k) => `${names[k] || k} ${by[k]}`).join('、') + '</div>';
    h += issues.slice(0, 60).map((i) => `<div class="issue">${esc(i.msg)}</div>`).join('');
    if (issues.length > 60) h += `<div class="small">只顯示前 60 項</div>`;
    el.innerHTML = h;
  }

  function renderStaff() {
    let h = `<tr><th>姓名</th><th>職級</th><th>本月班</th><th>${UNIT === '3AB' ? '支援2A' : '支援3AB'}</th><th>上月班</th><th>預假登記日</th><th></th></tr>`;
    S.staff.forEach((p, i) => {
      h += `<tr><td><input type="text" data-i="${i}" data-k="name" value="${esc(p.name)}"></td>
      <td><select data-i="${i}" data-k="level">${LEVELS.map((l) => `<option ${l === p.level ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><select data-i="${i}" data-k="shift">${['D', 'E', 'N'].map((l) => `<option ${l === p.shift ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-i="${i}" data-k="lendable" ${p.lendable ? 'checked' : ''}></td>
      <td><select data-i="${i}" data-k="prevShift">${['', 'D', 'E', 'N'].map((l) => `<option ${l === p.prevShift ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="date" data-i="${i}" data-k="prebookAt" value="${p.prebookAt || ''}" style="width:130px"></td>
      <td><button data-del="${i}">刪</button></td></tr>`;
    });
    $('staffTable').innerHTML = h;
    $('staffTable').querySelectorAll('[data-k]').forEach((el) => {
      el.onchange = () => {
        const p = S.staff[el.dataset.i];
        p[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.k === 'lendable') S.lendTouched = true; // 勾選過之後，沒勾的人就不會被借出（全都不勾＝不借出）
        save(); render(false);
      };
    });
    $('staffTable').querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => { S.staff.splice(b.dataset.del, 1); save(); render(); };
    });
  }

  function render(withStaff = true) {
    $('month').value = `${S.year}-${String(S.month).padStart(2, '0')}`;
    $('required').value = S.requiredRest;
    $('holidays').value = S.holidays.join(',');
    $('requestedAt').value = S.requestedAt || '';
    $('prebookBar').hidden = mode !== 'prebook';
    $('autoCard').hidden = mode !== 'schedule';
    $('supportMax').value = S.supportMax;
    renderAutoReport();
    $('gridTitle').textContent = mode === 'schedule' ? `${S.year} 年 ${S.month} 月 班表` : `${S.year} 年 ${S.month} 月 預假登記`;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    renderBrushes();
    const issues = issuesNow();
    renderGrid(issues);
    renderIssues(issues);
    renderRestStats();
    if (withStaff) renderStaff();
  }

  // 人力試算：每班需求人日 vs 可上班人日，說明缺人的原因
  function capacityHtml() {
    const lab = { D: '白班', E: '小夜', N: '大夜' };
    const n = nDays();
    const covOf = (u) => (u === '3AB' ? { D: { weekday: 7, off: 6 }, E: 5, N: 4 } : { D: 1, E: 1, N: 1 });
    const one = (st, cov, hol, name) => {
      const out = {};
      ['D', 'E', 'N'].forEach((s) => {
        let need = 0; for (let d = 1; d <= n; d++) need += R.coverageNeed(cov, s, st.year, st.month, d, hol);
        let sup = 0, cnt = 0;
        st.staff.forEach((p) => { if (p.shift !== s) return; if (!p.extra) cnt++; sup += n - (p.extra && p.restDays != null ? p.restDays : st.requiredRest); });
        out[s] = { need, sup, cnt };
      });
      return out;
    };
    const mineCap = one(S, CFG.coverage, S.holidays || [], UNIT);
    const O = loadOther();
    const rows = [[UNIT, mineCap]];
    if (O && O.year === S.year && O.month === S.month) rows.push([UNIT === '3AB' ? '2A' : '3AB', one(O, covOf(UNIT === '3AB' ? '2A' : '3AB'), O.holidays || [], '')]);
    let h = '<div class="small" style="margin-top:8px"><b>缺人原因（人力試算，以標準應休 ' + S.requiredRest + ' 天計）</b><br>';
    const tot = {};
    rows.forEach(([u, cap]) => ['D', 'E', 'N'].forEach((s) => {
      const c = cap[s]; const diff = c.sup - c.need;
      tot[s] = (tot[s] || 0) + diff;
      h += `${u}${lab[s]}：${c.cnt} 人，需要 ${c.need} 人天，最多可上 ${c.sup} 人天 → ${diff >= 0 ? '多出 ' + diff : '<span style="color:#b91c1c">不足 ' + (-diff) + '</span>'}<br>`;
    }));
    if (rows.length > 1) {
      h += '兩單位合計：' + ['D', 'E', 'N'].map((s) => `${lab[s]}${tot[s] >= 0 ? '多 ' + tot[s] : '不足 ' + (-tot[s])}`).join('、') + '。<br>';
      const lack = ['D', 'E', 'N'].filter((s) => tot[s] < 0), more = ['D', 'E', 'N'].filter((s) => tot[s] > 0);
      if (lack.length && more.length) h += `${more.map((s) => lab[s]).join('、')}人力有多、${lack.map((s) => lab[s]).join('、')}不夠；但借調只能借「同一個班別」的人，白班的人不會去上${lack.map((s) => lab[s]).join('、')}，所以${lack.map((s) => lab[s]).join('、')}會缺人、其他班會多休。`;
      else if (lack.length) h += '這幾班整體人力就不夠。';
    }
    return h + '</div>';
  }

  function renderAutoReport() {
    const el = $('autoReport');
    const r = S.autoReport;
    if (!r) { el.innerHTML = ''; return; }
    const lab = { D: '白班', E: '小夜', N: '大夜' };
    let h = '';
    ['D', 'E', 'N'].forEach((s) => {
      const days = r.gaps.filter((g) => g.shift === s).map((g) => g.day);
      if (days.length) h += `<div class="issue">${lab[s]}缺人 ${days.length} 天：${days.map((d) => S.month + '/' + d).join('、')}</div>`;
    });
    const used = Object.keys(r.supportUsage || {}).map((id) => {
      const p = S.staff.find((x) => x.id === id);
      return p ? `${esc(p.name)} ${r.supportUsage[id]} 天` : '';
    }).filter(Boolean);
    if (used.length) h += `<div class="small">支援人員使用：${used.join('、')}</div>`;
    const lentList = Object.keys(r.lent || {}).map((id) => { const p = S.staff.find((x) => x.id === id); return p ? `${esc(p.name)} ${r.lent[id]} 天` : ''; }).filter(Boolean);
    if (lentList.length) h += `<div class="small">固定人員借調（${CFG.lend}）：${lentList.join('、')}（本單位不需要她們的日子）</div>`;
    if ((r.rejected || []).length) {
      h += `<div class="issue">以下預假因當天人力不足被削減（特休優先，同類以先登記者優先），已由系統另排休息日：<br>` +
        r.rejected.map((q) => `${esc(q.name)} ${S.month}/${q.day} ${q.code}`).join('、') + '</div>';
    }
    if ((r.loans || []).length) {
      const byKey = {};
      r.loans.forEach((l) => { const k = `${l.from}→${l.to} ${lab[l.shift]}`; byKey[k] = (byKey[k] || 0) + l.n; });
      h += `<div class="small">借調（聯合排班）：${Object.keys(byKey).map((k) => `${k} ${byKey[k]} 人天`).join('；')}</div>`;
    }
    (r.notes || []).forEach((n) => (h += `<div class="issue">${esc(n)}</div>`));
    if (!r.gaps.length && !(r.notes || []).length && !(r.rejected || []).length) h = '<div class="ok">已排滿，每班每天都有人。</div>' + h;
    if (r.gaps.length) h += capacityHtml();
    if (r.gaps.length) h += '<div class="small">缺人的日子，可以指定更多支援人員（N2 以上）、增加特約人員，或調高「支援每人最多」天數，再按自動排班。</div>';
    el.innerHTML = h;
  }

  function runAuto(newSeed, incoming) {
    S.staff.forEach((p) => { if (p.restAuto) { delete p.restDays; delete p.restAuto; } });
    if (newSeed) S.seed = (S.seed || 1) + 1;
    const n = nDays();
    // 只保留手動填的格子，系統上次排的與預假審核結果都重算
    const manual = {};
    S.staff.forEach((p) => {
      const r = rowOf0(p.id, n);
      const a = S.auto[p.id] || [];
      manual[p.id] = r.map((c, i) => (a[i] ? '' : c));
    });
    const common = { lendTouched: S.lendTouched, year: S.year, month: S.month, staff: S.staff, requiredRest: S.requiredRest, holidays: S.holidays, params: { supportMaxDays: S.supportMax, coverage: CFG.coverage, requireSenior: CFG.requireSenior }, lendCode: CFG.lend, incoming };
    // 預假審核：特休優先，同類依登記先後；人力不足的預假被削減
    const pr = window.Solver.resolvePrebooks({ ...common, cells: manual, prebook: S.prebook });
    const res = window.Solver.autoSchedule({ ...common, cells: pr.cells, seed: S.seed });
    S.staff.forEach((p) => {
      if (!res.cells[p.id]) return; // 特約人員不自動排
      S.cells[p.id] = res.cells[p.id];
      S.auto[p.id] = res.cells[p.id].map((c, i) => (!c || manual[p.id][i] ? 0 : ((pr.accepted[p.id] || [])[i]) ? 2 : 1));
    });
    S.autoReport = { gaps: res.gaps, supportUsage: res.supportUsage, lent: res.lent, notes: res.notes, rejected: pr.rejected };
    save(); render(false);
  }
  // 聯合排班：兩個單位一起排，缺人的日子互相借人（也可以在借出方的班表手動標借調代碼）
  async function runJoint(newSeed, onProgress) {
    const other = UNIT === '3AB' ? '2A' : '3AB';
    const okey = other === '3AB' ? 'miaoli-scheduler-3ab-v1' : 'miaoli-scheduler-2a-v1';
    let O = null;
    try { O = JSON.parse(localStorage.getItem(okey)); } catch (e) {}
    const rep = $('autoReport');
    if (!O || !O.staff || !O.staff.length) { rep.innerHTML = `<div class="issue">${other} 還沒有人員資料，請先切換到 ${other} 設定人員。</div>`; return; }
    if (O.year !== S.year || O.month !== S.month) { rep.innerHTML = `<div class="issue">${other} 的月份是 ${O.year}/${O.month}，和這邊的 ${S.year}/${S.month} 不同，請先把兩邊調成同一個月。</div>`; return; }
    if (newSeed) S.seed = (S.seed || 1) + 1;
    const n = nDays();
    const cfgOf = (u) => (u === '3AB' ? { coverage: { D: { weekday: 7, off: 6 }, E: 5, N: 4 }, lend: '2A', requireSenior: true, lendNeedsSenior: true } : { coverage: { D: 1, E: 1, N: 1 }, lend: '3AB', requireSenior: false, lendNeedsSenior: false });
    const build = (u, st) => {
      const c = cfgOf(u);
      st.staff.forEach((p) => { if (p.restAuto) { delete p.restDays; delete p.restAuto; } });
      const manual = {};
      st.staff.forEach((p) => { const r = (st.cells && st.cells[p.id]) || []; const au = (st.auto && st.auto[p.id]) || []; manual[p.id] = Array.from({ length: n }, (_, i) => (au[i] ? '' : r[i] || '')); });
      const rr = st.restManual ? st.requiredRest : R.redDays(st.year, st.month, st.holidays || []);
      st.requiredRest = rr;
      const base = { lendTouched: st.lendTouched, name: u, year: st.year, month: st.month, staff: st.staff, requiredRest: rr, holidays: st.holidays || [], params: { supportMaxDays: st.supportMax == null ? 6 : st.supportMax, coverage: c.coverage, requireSenior: c.requireSenior }, lendCode: c.lend, lendNeedsSenior: c.lendNeedsSenior, seed: st.seed || 1 };
      const pr = window.Solver.resolvePrebooks({ ...base, cells: manual, prebook: st.prebook || {} });
      return { manual, pr, unit: { ...base, cells: pr.cells, auto: {} }, c };
    };
    const mine = build(UNIT, S), theirs = build(other, O);
    const us = UNIT === '2A' ? [mine.unit, theirs.unit] : [theirs.unit, mine.unit];
    // 分段執行：每次嘗試之間讓出畫面，顯示進度；超過時間預算就採用目前最好的結果
    // 人力不足時會自動減少全體休假天數（各班別最多差 2 天），並在人員表顯示每人實際月休
    const plan = window.Solver.jointStart(us); const t0 = Date.now(); const BUDGET = 40000;
    for (let t = 0; t < 12 && !plan.done; t++) {
      if (plan.best && Date.now() - t0 > BUDGET) break;
      if (onProgress) onProgress(`排班中… 第 ${t + 1} 次`);
      await new Promise((r) => setTimeout(r, 30));
      window.Solver.jointStep(plan);
    }
    const best = plan.best;
    const j = best.r;
    const resOf = (u) => (u === '2A' ? j.A : j.B);
    const apply = (st, b, res) => {
      if (!st.cells) st.cells = {}; if (!st.auto) st.auto = {};
      st.staff.forEach((p) => {
        if (!res.cells[p.id]) return;
        st.cells[p.id] = res.cells[p.id];
        st.auto[p.id] = res.cells[p.id].map((c, i) => (!c || b.manual[p.id][i] ? 0 : ((b.pr.accepted[p.id] || [])[i]) ? 2 : 1));
      });
      st.incoming = res.incoming;
      st.staff.forEach((p) => { if (res.restDays && res.restDays[p.id] != null) { p.restDays = res.restDays[p.id]; p.restAuto = true; } });
      st.autoReport = { gaps: res.gaps, supportUsage: res.supportUsage, lent: res.lent, notes: res.notes, rejected: b.pr.rejected, loans: j.loans };
    };
    apply(S, mine, resOf(UNIT)); apply(O, theirs, resOf(other));
    try { localStorage.setItem(okey, JSON.stringify(O)); } catch (e) {}
    save(); render(false);
  }
  const jb = $('jointRun');
  if (jb) jb.onclick = async () => { const t = jb.textContent; jb.textContent = '排班中…'; jb.disabled = true; try { await runJoint(true, (m) => { jb.textContent = m; }); } catch (e) { const rep = $('autoReport'); if (rep) rep.innerHTML = `<div class="issue">排班發生錯誤：${esc(e && e.message || e)}</div>`; } finally { jb.textContent = t; jb.disabled = false; } };
  // 只排 3AB：不動 2A 的班表；2A 班表上已標「3AB」的日子算作 3AB 的借入人力
  function run3AB() {
    const n = nDays(), inc = {};
    const O = loadOther();
    if (O && O.staff && O.year === S.year && O.month === S.month) {
      O.staff.forEach((p) => {
        if (p.extra) return;
        ((O.cells || {})[p.id] || []).slice(0, n).forEach((c, i) => { if (c === '3AB') { if (!inc[p.shift]) inc[p.shift] = new Array(n).fill(0); inc[p.shift][i]++; } });
      });
      if (O.incoming) { delete O.incoming; try { localStorage.setItem('miaoli-scheduler-2a-v1', JSON.stringify(O)); } catch (e) {} } // 之前聯合排班的借入人數已失效
    }
    S.incoming = inc;
    runAuto(true, inc);
  }
  $('run3AB').onclick = () => {
    if (UNIT === '3AB') return run3AB();
    let T = null;
    try { T = JSON.parse(localStorage.getItem('miaoli-scheduler-3ab-v1')); } catch (e) {}
    if (!T || !T.staff || !T.staff.length) { $('autoReport').innerHTML = '<div class="issue">3AB 還沒有人員資料，請先匯入 3AB 人員設定。</div>'; return; }
    if (T.year !== S.year || T.month !== S.month) { $('autoReport').innerHTML = `<div class="issue">3AB 的月份是 ${T.year}/${T.month}，和這邊的 ${S.year}/${S.month} 不同，請先把兩邊調成同一個月。</div>`; return; }
    try { sessionStorage.setItem('miaoli-run3ab', '1'); localStorage.setItem('miaoli-unit', '3AB'); } catch (e) {}
    location.reload();
  };
  $('importXlsx').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const list = window.XlsxImport.candidates(await window.XlsxImport.readWorkbook(await f.arrayBuffer()));
      if (!list.length) throw new Error('找不到 2A 班表（需要有一列 1、2、3… 的日期，以及人員姓名）');
      let parsed = list[0];
      if (list.length > 1) {
        const k = prompt('檔案裡有多張班表，請輸入要匯入的編號：\n' + list.map((x, i) => `${i + 1}. ${x.sheet}`).join('\n'), String(list.length));
        if (k === null) return;
        parsed = list[Number(k) - 1];
        if (!parsed) throw new Error('編號不正確');
      }
      let { year, month } = parsed;
      if (!year || !month || month > 12) {
        const k = prompt('表頭沒有寫年月，請輸入（例如 2026-12）：', `${S.year}-${String(S.month).padStart(2, '0')}`);
        if (k === null) return;
        [year, month] = k.split('-').map(Number);
        if (!year || !(month >= 1 && month <= 12)) throw new Error('年月格式不正確');
      }
      if (R.daysInMonth(year, month) !== parsed.days) throw new Error(`${year}/${month} 應有 ${R.daysInMonth(year, month)} 天，表上是 ${parsed.days} 天`);
      let old = null;
      try { old = JSON.parse(localStorage.getItem('miaoli-scheduler-2a-v1')); } catch (err) {}
      const out = window.XlsxImport.toState(old, parsed, year, month, window.Holidays.forMonth(year, month));
      const unknown = Object.keys(parsed.unknown);
      const msg = `匯入到 2A：${year} 年 ${month} 月，共 ${parsed.people.length} 人\n` +
        parsed.people.map((q) => `${q.name}（${q.level || '職級未寫'} ${q.shift || '班別未知'}${q.support ? ' 支援' : ''}）`).join('、') +
        (out.removed.length ? `\n\n不在 Excel 裡、會從 2A 名單移除：${out.removed.join('、')}` : '') +
        (unknown.length ? `\n\n系統不認得的代碼（照原字保留，請檢查）：${unknown.join('、')}` : '') +
        '\n\n會覆蓋目前的 2A 班表，確定匯入？';
      if (!confirm(msg)) return;
      localStorage.setItem('miaoli-scheduler-2a-v1', JSON.stringify(out.state));
      localStorage.setItem('miaoli-unit', '2A');
      location.reload();
    } catch (err) { alert('匯入失敗：' + ((err && err.message) || err)); }
    finally { e.target.value = ''; }
  };
  $('supportMax').onchange = (e) => { S.supportMax = Math.max(0, Number(e.target.value) || 0); save(); };
  $('autoRun').onclick = () => runAuto(false);
  $('autoClear').onclick = () => {
    S.staff.forEach((p) => {
      const a = S.auto[p.id] || [];
      const r = rowOf0(p.id, nDays());
      S.cells[p.id] = r.map((c, i) => (a[i] ? '' : c));
      S.auto[p.id] = [];
    });
    S.autoReport = null; save(); render(false);
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  $('month').onchange = (e) => {
    const [y, m] = e.target.value.split('-').map(Number);
    if (y && m) { S.year = y; S.month = m; S.holidays = autoHolidays(); S.cells = {}; S.auto = {}; S.autoReport = null; S.prebook = {}; S.restManual = false; recalcRest(); save(); render(); }
  };
  $('holidays').onchange = (e) => {
    S.holidays = e.target.value.split(/[,，\s]+/).map(Number).filter((d) => d >= 1 && d <= nDays());
    S.restManual = false; recalcRest(); save(); render(false);
  };
  const us = $('unit');
  if (us) { us.value = UNIT; us.onchange = () => { try { localStorage.setItem('miaoli-unit', us.value); } catch (e) {} location.reload(); }; }
  document.title = UNIT + ' 排班';
  const h1u = document.getElementById('unitName'); if (h1u) h1u.textContent = UNIT;
  $('required').onchange = (e) => { S.requiredRest = Number(e.target.value); S.restManual = true; save(); render(false); };
  $('requestedAt').onchange = (e) => { S.requestedAt = e.target.value; save(); render(false); };
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => { mode = b.dataset.mode; render(false); }; });
  $('addStaff').onclick = () => { S.staff.push({ id: 's' + Date.now(), name: '新人員', level: 'N1', shift: 'D', support: false, prevShift: '' }); save(); render(); };
  $('fillWork').onclick = () => {
    if (mode !== 'schedule') return;
    S.staff.forEach((p) => { const r = rowOf(p.id); for (let i = 0; i < r.length; i++) if (!r[i]) r[i] = p.shift; });
    save(); render(false);
  };
  $('clearAll').onclick = () => { if (confirm('清空本月' + (mode === 'schedule' ? '班表' : '預假') + '？')) { if (mode === 'schedule') { S.cells = {}; S.auto = {}; S.autoReport = null; } else S.prebook = {}; save(); render(false); } };
  $('applyPrebook') && ($('applyPrebook').onclick = () => {
    S.staff.forEach((p) => {
      const pre = (S.prebook[p.id] || []);
      const r = (S.cells[p.id] = S.cells[p.id] || []);
      while (r.length < nDays()) r.push('');
      pre.forEach((c, i) => { if (c && !r[i]) r[i] = c; });
    });
    save(); mode = 'schedule'; render(false);
  });
  $('exportJson').onclick = () => download(`schedule-${UNIT}-${S.year}-${S.month}.json`, JSON.stringify({ ...S, unit: UNIT }, null, 2), 'application/json');
  $('exportCsv').onclick = () => {
    const n = nDays();
    const head = ['姓名', ...Array.from({ length: n }, (_, i) => `${S.month}/${i + 1}`)];
    const lines = [head, ...S.staff.map((p) => [p.name, ...rowOf0(p.id, n)])].map((r) => r.join(','));
    download(`schedule-${S.year}-${S.month}.csv`, '﻿' + lines.join('\n'), 'text/csv');
  };
  // 匯出 Excel：版面仿照護理長現行班表（每人兩列：上列班別、下列借調標記，右側統計休假天數）
  $('exportXlsx').onclick = () => {
    const bytes = window.Xlsx.workbook([window.Xlsx.scheduleSheet({ ...S, borrowed: borrowedRows() }, UNIT)]);
    download(`${UNIT}-${S.year - 1911}年${S.month}月班表.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  $('exportXlsx2').onclick = () => {
    const other = UNIT === '3AB' ? '2A' : '3AB';
    let O = null;
    try { O = JSON.parse(localStorage.getItem(other === '3AB' ? 'miaoli-scheduler-3ab-v1' : 'miaoli-scheduler-2a-v1')); } catch (e) {}
    if (!O || !O.staff || !O.staff.length || O.year !== S.year || O.month !== S.month) { alert(`${other} 沒有同一個月的資料，請先在 ${other} 排好班（或匯入）。`); return; }
    const sheets = UNIT === '2A' ? [window.Xlsx.scheduleSheet({ ...S, borrowed: borrowedFrom(O, '2A', S) }, '2A'), window.Xlsx.scheduleSheet({ ...O, borrowed: borrowedFrom(S, '3AB', O) }, '3AB')] : [window.Xlsx.scheduleSheet({ ...O, borrowed: borrowedFrom(S, '2A', O) }, '2A'), window.Xlsx.scheduleSheet({ ...S, borrowed: borrowedFrom(O, '3AB', S) }, '3AB')];
    download(`2A+3AB-${S.year - 1911}年${S.month}月班表.xlsx`, window.Xlsx.workbook(sheets), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const rowOf0 = (id, n) => { const r = (S.cells[id] || []).slice(0, n); while (r.length < n) r.push(''); return r; };
  $('importJson').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(rd.result);
        if (!obj || !Array.isArray(obj.staff)) throw new Error('bad');
        const u = obj.unit === '3AB' || obj.unit === '2A' ? obj.unit : UNIT; // 檔案標明單位就載入到該單位
        if (u !== UNIT) {
          const k = u === '3AB' ? 'miaoli-scheduler-3ab-v1' : 'miaoli-scheduler-2a-v1';
          localStorage.setItem(k, JSON.stringify(obj)); localStorage.setItem('miaoli-unit', u);
          alert(`這是 ${u} 的檔案，已載入到 ${u}，頁面將切換過去。`); location.reload(); return;
        }
        S = obj; save(); render();
      } catch (err) { alert('檔案格式不正確'); }
    };
    rd.readAsText(f);
  };
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
  }
  render();
  let pending = false;
  try { pending = sessionStorage.getItem('miaoli-run3ab') === '1'; sessionStorage.removeItem('miaoli-run3ab'); } catch (e) {}
  if (pending && UNIT === '3AB') setTimeout(() => $('run3AB').click(), 50);
})();
