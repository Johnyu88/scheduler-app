(function () {
  const R = window.Rules;
  const KEY = 'miaoli-scheduler-2a-v1';
  const LEVELS = ['N', 'N1', 'N2', 'N3', 'N4'];
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const BRUSHES = [
    { code: '班', label: '上班', cls: 'D' }, { code: '例', label: '例', cls: 'rest' }, { code: '休息', label: '休息', cls: 'rest' },
    { code: '休假', label: '休假', cls: 'leave' }, { code: '特休', label: '特休', cls: 'leave' }, { code: '補休', label: '補休', cls: 'rest' },
    { code: '國定', label: '國定', cls: 'rest' }, { code: '3AB', label: '支援3AB', cls: 'lend' }, { code: '公假', label: '公假', cls: 'leave' }, { code: '', label: '清除', cls: '' },
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
    if (c === '3AB') return 'lend';
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
    const params = { year: S.year, month: S.month, staff: S.staff, requiredRest: S.requiredRest };
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
      h += `<tr><td class="name">${esc(p.name)}<div class="small">${p.level} ${p.shift}${p.support ? ' 支援' : ''}</div></td>`;
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
    let h = '<tr><th>姓名</th><th>職級</th><th>本月班</th><th>支援</th><th>上月班</th><th>預假登記日</th><th></th></tr>';
    S.staff.forEach((p, i) => {
      h += `<tr><td><input type="text" data-i="${i}" data-k="name" value="${esc(p.name)}"></td>
      <td><select data-i="${i}" data-k="level">${LEVELS.map((l) => `<option ${l === p.level ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><select data-i="${i}" data-k="shift">${['D', 'E', 'N'].map((l) => `<option ${l === p.shift ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-i="${i}" data-k="support" ${p.support ? 'checked' : ''}></td>
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
    if (used.length) h += `<div class="small">3AB 支援人員使用：${used.join('、')}</div>`;
    const lentList = Object.keys(r.lent || {}).map((id) => { const p = S.staff.find((x) => x.id === id); return p ? `${esc(p.name)} ${r.lent[id]} 天` : ''; }).filter(Boolean);
    if (lentList.length) h += `<div class="small">固定人員支援 3AB：${lentList.join('、')}（2A 不需要她們的日子）</div>`;
    if ((r.rejected || []).length) {
      h += `<div class="issue">以下預假因當天人力不足被削減（特休優先，同類以先登記者優先），已由系統另排休息日：<br>` +
        r.rejected.map((q) => `${esc(q.name)} ${S.month}/${q.day} ${q.code}`).join('、') + '</div>';
    }
    (r.notes || []).forEach((n) => (h += `<div class="issue">${esc(n)}</div>`));
    if (!r.gaps.length && !(r.notes || []).length && !(r.rejected || []).length) h = '<div class="ok">已排滿，每班每天都有人。</div>' + h;
    if (r.gaps.length) h += '<div class="small">缺人的日子，可以指定更多 3AB 支援人員（N2 以上），或調高「支援每人最多」天數，再按自動排班。</div>';
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
    const common = { year: S.year, month: S.month, staff: S.staff, requiredRest: S.requiredRest, holidays: S.holidays, params: { supportMaxDays: S.supportMax } };
    // 預假審核：特休優先，同類依登記先後；人力不足的預假被削減
    const pr = window.Solver.resolvePrebooks({ ...common, cells: manual, prebook: S.prebook });
    const res = window.Solver.autoSchedule({ ...common, cells: pr.cells, seed: S.seed });
    S.staff.forEach((p) => {
      S.cells[p.id] = res.cells[p.id];
      S.auto[p.id] = res.cells[p.id].map((c, i) => (!c || manual[p.id][i] ? 0 : pr.accepted[p.id][i] ? 2 : 1));
    });
    S.autoReport = { gaps: res.gaps, supportUsage: res.supportUsage, lent: res.lent, notes: res.notes, rejected: pr.rejected };
    save(); render(false);
  }
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
  $('exportJson').onclick = () => download('schedule.json', JSON.stringify(S, null, 2), 'application/json');
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
    rd.onload = () => { try { S = JSON.parse(rd.result); save(); render(); } catch (err) { alert('檔案格式不正確'); } };
    rd.readAsText(f);
  };
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
  }
  render();
})();
