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
    { code: '國定', label: '國定', cls: 'rest' }, { code: CFG.lend, label: CFG.lendLabel, cls: 'lend' }, { code: '公假', label: '公假', cls: 'leave' }, { code: '', label: '清除', cls: '' },
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
  if (!S.holidays.length) S.holidays = autoHolidays();
  const recalcRest = () => { S.requiredRest = R.redDays(S.year, S.month, S.holidays); };
  if (!S.requiredRest) recalcRest();
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
    const params = { year: S.year, month: S.month, staff: S.staff, requiredRest: S.requiredRest, holidays: S.holidays, params: { coverage: CFG.coverage, requireSenior: CFG.requireSenior }, incoming: S.incoming };
    return mode === 'schedule'
      ? R.checkSchedule({ ...params, cells: S.cells })
      : R.checkPrebook({ ...params, requestedAt: S.requestedAt, prebook: S.prebook });
  }

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
      h += `<tr><td class="name">${esc(p.name)}<div class="small">${p.level} ${p.shift}${p.support ? ' 支援' : ''}${p.extra ? ' 特約' : ''}</div></td>`;
      for (let d = 1; d <= n; d++) {
        const w = R.dow(S.year, S.month, d);
        const c = r[d - 1];
        const isAuto = mode === 'schedule' && S.auto[p.id] && S.auto[p.id][d - 1];
        h += `<td class="c ${codeClass(c)} ${w === 0 || w === 6 ? 'we' : ''} ${bad.has(p.id + ':' + d) ? 'bad' : ''} ${isAuto === 2 ? 'pre' : isAuto ? 'auto' : ''}" data-id="${p.id}" data-d="${d}">${c}</td>`;
      }
      h += '</tr>';
    });
    if (mode === 'schedule') {
      const lab = { D: '白', E: '小', N: '大' };
      ['D', 'E', 'N'].forEach((s) => {
        h += `<tr><td class="name">${lab[s]}班人數</td>`;
        for (let d = 1; d <= n; d++) {
          const c = S.staff.filter((p) => rowOf(p.id)[d - 1] === s).length;
          h += `<td class="cnt ${c === 1 ? 'good' : 'bad'}">${c}</td>`;
        }
        h += '</tr>';
      });
    }
    g.innerHTML = h;
    g.querySelectorAll('td.c').forEach((td) => {
      td.onclick = () => {
        const p = S.staff.find((x) => x.id === td.dataset.id);
        const r = rowOf(p.id);
        r[td.dataset.d - 1] = brush === '班' ? p.shift : brush;
        if (mode === 'schedule' && S.auto[p.id]) S.auto[p.id][td.dataset.d - 1] = false;
        save(); render();
      };
    });
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
    let h = '<tr><th>姓名</th><th>職級</th><th>本月班</th><th>支援</th><th>特約</th><th>上月班</th><th>預假登記日</th><th></th></tr>';
    S.staff.forEach((p, i) => {
      h += `<tr><td><input type="text" data-i="${i}" data-k="name" value="${esc(p.name)}"></td>
      <td><select data-i="${i}" data-k="level">${LEVELS.map((l) => `<option ${l === p.level ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><select data-i="${i}" data-k="shift">${['D', 'E', 'N'].map((l) => `<option ${l === p.shift ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-i="${i}" data-k="support" ${p.support ? 'checked' : ''}></td>
      <td><input type="checkbox" data-i="${i}" data-k="extra" ${p.extra ? 'checked' : ''}></td>
      <td><select data-i="${i}" data-k="prevShift">${['', 'D', 'E', 'N'].map((l) => `<option ${l === p.prevShift ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="date" data-i="${i}" data-k="prebookAt" value="${p.prebookAt || ''}" style="width:130px"></td>
      <td><button data-del="${i}">刪</button></td></tr>`;
    });
    $('staffTable').innerHTML = h;
    $('staffTable').querySelectorAll('[data-k]').forEach((el) => {
      el.onchange = () => {
        const p = S.staff[el.dataset.i];
        p[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
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
    if (withStaff) renderStaff();
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
    if (r.gaps.length) h += '<div class="small">缺人的日子，可以指定更多支援人員（N2 以上）、增加特約人員，或調高「支援每人最多」天數，再按自動排班。</div>';
    el.innerHTML = h;
  }

  function runAuto(newSeed) {
    if (newSeed) S.seed = (S.seed || 1) + 1;
    const n = nDays();
    // 只保留手動填的格子，系統上次排的與預假審核結果都重算
    const manual = {};
    S.staff.forEach((p) => {
      const r = rowOf0(p.id, n);
      const a = S.auto[p.id] || [];
      manual[p.id] = r.map((c, i) => (a[i] ? '' : c));
    });
    const common = { year: S.year, month: S.month, staff: S.staff, requiredRest: S.requiredRest, holidays: S.holidays, params: { supportMaxDays: S.supportMax, coverage: CFG.coverage, requireSenior: CFG.requireSenior }, lendCode: CFG.lend };
    // 預假審核：特休優先，同類依登記先後；人力不足的預假被削減
    const pr = window.Solver.resolvePrebooks({ ...common, cells: manual, prebook: S.prebook });
    const res = window.Solver.autoSchedule({ ...common, cells: pr.cells, seed: S.seed });
    S.staff.forEach((p) => {
      if (!res.cells[p.id]) return; // 特約人員不自動排
      S.cells[p.id] = res.cells[p.id];
      S.auto[p.id] = res.cells[p.id].map((c, i) => (!c || manual[p.id][i] ? 0 : pr.accepted[p.id][i] ? 2 : 1));
    });
    S.autoReport = { gaps: res.gaps, supportUsage: res.supportUsage, lent: res.lent, notes: res.notes, rejected: pr.rejected };
    save(); render(false);
  }
  // 聯合排班：兩個單位一起排，缺人的日子互相借人（也可以在借出方的班表手動標借調代碼）
  function runJoint(newSeed) {
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
      const manual = {};
      st.staff.forEach((p) => { const r = (st.cells && st.cells[p.id]) || []; const au = (st.auto && st.auto[p.id]) || []; manual[p.id] = Array.from({ length: n }, (_, i) => (au[i] ? '' : r[i] || '')); });
      const base = { name: u, year: st.year, month: st.month, staff: st.staff, requiredRest: st.requiredRest, holidays: st.holidays || [], params: { supportMaxDays: st.supportMax == null ? 6 : st.supportMax, coverage: c.coverage, requireSenior: c.requireSenior }, lendCode: c.lend, lendNeedsSenior: c.lendNeedsSenior, seed: st.seed || 1 };
      const pr = window.Solver.resolvePrebooks({ ...base, cells: manual, prebook: st.prebook || {} });
      return { manual, pr, unit: { ...base, cells: pr.cells, auto: {} }, c };
    };
    const mine = build(UNIT, S), theirs = build(other, O);
    const j = window.Solver.jointSchedule(UNIT === '2A' ? [mine.unit, theirs.unit] : [theirs.unit, mine.unit]);
    const resOf = (u) => (u === '2A' ? j.A : j.B);
    const apply = (st, b, res) => {
      if (!st.cells) st.cells = {}; if (!st.auto) st.auto = {};
      st.staff.forEach((p) => {
        if (!res.cells[p.id]) return;
        st.cells[p.id] = res.cells[p.id];
        st.auto[p.id] = res.cells[p.id].map((c, i) => (!c || b.manual[p.id][i] ? 0 : b.pr.accepted[p.id][i] ? 2 : 1));
      });
      st.incoming = res.incoming;
      st.autoReport = { gaps: res.gaps, supportUsage: res.supportUsage, lent: res.lent, notes: res.notes, rejected: b.pr.rejected, loans: j.loans };
    };
    apply(S, mine, resOf(UNIT)); apply(O, theirs, resOf(other));
    try { localStorage.setItem(okey, JSON.stringify(O)); } catch (e) {}
    save(); render(false);
  }
  const jb = $('jointRun');
  if (jb) jb.onclick = () => { const t = jb.textContent; jb.textContent = '排班中…'; jb.disabled = true; setTimeout(() => { try { runJoint(false); } finally { jb.textContent = t; jb.disabled = false; } }, 30); };
  $('supportMax').onchange = (e) => { S.supportMax = Math.max(0, Number(e.target.value) || 0); save(); };
  $('autoRun').onclick = () => runAuto(false);
  $('autoAgain').onclick = () => runAuto(true);
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
    if (y && m) { S.year = y; S.month = m; S.holidays = autoHolidays(); S.cells = {}; S.auto = {}; S.autoReport = null; S.prebook = {}; recalcRest(); save(); render(); }
  };
  $('holidays').onchange = (e) => {
    S.holidays = e.target.value.split(/[,，\s]+/).map(Number).filter((d) => d >= 1 && d <= nDays());
    recalcRest(); save(); render(false);
  };
  const us = $('unit');
  if (us) { us.value = UNIT; us.onchange = () => { try { localStorage.setItem('miaoli-unit', us.value); } catch (e) {} location.reload(); }; }
  document.title = UNIT + ' 排班';
  const h1u = document.getElementById('unitName'); if (h1u) h1u.textContent = UNIT;
  $('required').onchange = (e) => { S.requiredRest = Number(e.target.value); save(); render(false); };
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
})();
