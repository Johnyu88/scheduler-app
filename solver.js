// 自動排班：依規則產生「建議班表」，護理長再手動微調。
//
// 模型（來自護理長確認的規則）
// - 白、小夜、大夜三班各自求解（人員月內班別固定，互不相干）
// - 每班每天 2A 只需 1 人；固定人員每月休息日數 = 行政院休假日數（特休、公假另計）
// - 固定人員除了排 2A，剩下沒被用到的上班日去支援 3AB，班表上標「3AB」
// - 固定人員不夠排滿的日子，才由護理長指定的 3AB 支援人員補，仍不足就列為缺人
//
// 做法：先替每位固定人員產生許多「休息日型態」（各自符合連續上班、每 2 週例假、
// 每 4 週休息、休息日數剛好等規則），再從中挑出讓 2A 每天都有人、且不同班別休息日錯開的組合。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.Solver = factory(root.Rules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  const WORK = R.WORK;
  const REST_CODES = R.MONTH_REST; // 計入應休天數的代碼
  const LEGAL = R.LEGAL_REST;
  const DEFAULTS = { maxConsecutive: 6, softStreak: 5, supportMaxDays: 6 };
  const LEND = '3AB';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function spread(list, k) {
    if (k <= 0 || !list.length) return [];
    if (k >= list.length) return list.slice();
    const out = [];
    for (let i = 0; i < k; i++) out.push(list[Math.floor(((i + 0.5) * list.length) / k)]);
    return out;
  }
  const normRow = (r, n) => { const a = (r || []).slice(0, n); while (a.length < n) a.push(''); return a; };

  function makeCtx(input) {
    const { year, month, staff } = input;
    const n = R.daysInMonth(year, month);
    let sundays = 0;
    for (let d = 1; d <= n; d++) if (R.dow(year, month, d) === 0) sundays++;
    return {
      year, month, staff, n, sundays,
      need: input.requiredRest == null ? 0 : input.requiredRest,
      holidays: new Set(input.holidays || []),
      P: Object.assign({}, DEFAULTS, input.params || {}),
    };
  }

  // 一位固定人員的限制條件
  function spec(ctx, p, row) {
    const { n, need } = ctx;
    const fixedOff = row.map((c) => !!c && c !== p.shift && c !== LEND);
    const forced = row.map((c) => c === p.shift || c === LEND);
    const cnt = (a, b, f) => { let t = 0; for (let d = a; d <= b && d <= n; d++) if (f(row[d - 1], d - 1)) t++; return t; };
    const fixedRest = cnt(1, n, (c) => REST_CODES.includes(c));
    return {
      p, row, fixedOff, forced,
      Rn: Math.max(0, need - fixedRest), // 還需要系統安排的休息日數
      fixedLi1: cnt(1, 14, (c) => c === '例'),
      fixedLi2: cnt(15, 28, (c) => c === '例'),
      fixedLegal28: cnt(1, 28, (c) => LEGAL.includes(c)),
      blocked1: !!(p.prevShift && p.prevShift !== p.shift),
      streak0: p.prevStreak || 0,
    };
  }

  // 隨機產生一個合規的休息日型態（true = 系統安排的休息日）
  function genPattern(ctx, sp, rng) {
    const { n, P } = ctx;
    const off = new Array(n).fill(false);
    const free = (i) => !sp.fixedOff[i] && !sp.forced[i];
    const freeLeft = (a, b) => { let t = 0; for (let d = a; d <= b && d <= n; d++) if (free(d - 1)) t++; return t; };
    const need1 = Math.max(0, 2 - sp.fixedLi1);
    const need2 = Math.max(0, 2 - sp.fixedLi2);
    let nodes = 0;
    const rec = (d, used, streak, b1, b2, o28) => {
      if (++nodes > 4000) return false;
      if (d > n) return used === sp.Rn;
      if (d === 15 && b1 < need1) return false;
      if (n >= 28 && d === 29 && (b2 < need2 || o28 + sp.fixedLegal28 < 8)) return false;
      const left = freeLeft(d, n);
      if (sp.Rn - used > left) return false;
      if (d <= 14 && b1 + freeLeft(d, 14) < need1) return false;
      if (n >= 28 && d <= 28) {
        if (d >= 15 && b2 + freeLeft(d, 28) < need2) return false;
        if (o28 + freeLeft(d, 28) + sp.fixedLegal28 < 8) return false;
      }
      const i = d - 1;
      if (sp.fixedOff[i]) return rec(d + 1, used, 0, b1, b2, o28);
      if (sp.forced[i]) return streak + 1 > P.maxConsecutive ? false : rec(d + 1, used, streak + 1, b1, b2, o28);
      const canOn = streak + 1 <= P.maxConsecutive && !(d === 1 && sp.blocked1);
      const canOff = used < sp.Rn;
      const base = left ? (sp.Rn - used) / left : 0;
      const pOff = streak >= P.softStreak ? 0.9 : streak < 2 ? base * 0.3 : base;
      const opts = [];
      if (canOn) opts.push('on');
      if (canOff) opts.push('off');
      if (opts.length === 2 && rng() < pOff) opts.reverse();
      for (const o of opts) {
        if (o === 'on') { if (rec(d + 1, used, streak + 1, b1, b2, o28)) return true; }
        else {
          off[i] = true;
          if (rec(d + 1, used + 1, 0, b1 + (d <= 14 ? 1 : 0), b2 + (d >= 15 && d <= 28 ? 1 : 0), o28 + (d <= 28 ? 1 : 0))) return true;
          off[i] = false;
        }
      }
      return false;
    };
    return rec(1, 0, sp.streak0, 0, 0, 0) ? off.slice() : null;
  }

  function genPool(ctx, sp, rng, m) {
    const seen = new Set();
    const pool = [];
    for (let t = 0; t < m * 5 && pool.length < m; t++) {
      const o = genPattern(ctx, sp, rng);
      if (!o) { if (t > 20 && !pool.length) break; continue; }
      const key = o.map((v) => (v ? 1 : 0)).join('');
      if (!seen.has(key)) { seen.add(key); pool.push(o); }
    }
    return pool;
  }

  // 單一班別：選出休息日型態、決定每天誰在 2A、誰支援 3AB，再用支援人員補缺
  function solveShift(ctx, shift, cells, opts) {
    const { n, P } = ctx;
    opts = opts || {};
    const rng = opts.rng || mulberry32(1);
    const effort = opts.effort || 1;
    const core = ctx.staff.filter((p) => p.shift === shift && !p.support);
    const sups = ctx.staff.filter((p) => p.shift === shift && p.support);
    const specs = core.map((p) => spec(ctx, p, cells[p.id]));
    const pools = specs.map((sp) => genPool(ctx, sp, rng, 40 * effort));
    const failed = pools.findIndex((pl) => !pl.length);
    const supCap = sups.reduce((s, p) => s + Math.max(0, P.supportMaxDays - cells[p.id].filter((c) => c === shift).length), 0);
    const otherOff = opts.otherOff || new Array(n).fill(0);

    const presentOf = (sp, off, i) => !sp.fixedOff[i] && !off[i];
    const evalCombo = (combo) => {
      let uncovered = 0, overlap = 0;
      for (let i = 0; i < n; i++) {
        if (!combo.some((o, k) => presentOf(specs[k], o, i))) uncovered++;
        const offs = combo.filter((o, k) => !presentOf(specs[k], o, i)).length;
        overlap += offs * otherOff[i];
      }
      return { uncovered, cost: 1000 * Math.max(0, uncovered - supCap) + 12 * uncovered + 25 * overlap };
    };

    let best = null;
    if (failed >= 0) {
      return { ok: false, gaps: n, rows: null, specs, core, sups };
    }
    if (!core.length) best = { combo: [], uncovered: n };
    else {
      const total = pools.reduce((s, pl) => s * pl.length, 1);
      const tries = Math.min(total, 1500 * effort);
      const pick = (k) => (total <= 1500 * effort ? null : Math.floor(rng() * pools[k].length));
      for (let t = 0; t < tries; t++) {
        let combo;
        if (total <= 1500 * effort) { // 全部列舉
          let idx = t; combo = pools.map((pl) => { const o = pl[idx % pl.length]; idx = Math.floor(idx / pl.length); return o; });
        } else combo = pools.map((pl, k) => pl[pick(k)]);
        const e = evalCombo(combo);
        if (!best || e.cost < best.cost) best = { combo, cost: e.cost, uncovered: e.uncovered };
      }
    }

    // 寫入列：固定人員
    const rows = {};
    core.forEach((p) => (rows[p.id] = cells[p.id].slice()));
    const coverCount = core.map(() => 0);
    let prevCover = -1;
    const uncoveredDays = [];
    for (let i = 0; i < n; i++) {
      const present = core.map((p, k) => presentOf(specs[k], best.combo[k], i));
      const forcedCover = core.findIndex((p, k) => cells[p.id][i] === shift);
      let cover = -1;
      if (forcedCover >= 0) cover = forcedCover;
      else {
        const cand = present.map((v, k) => (v ? k : -1)).filter((k) => k >= 0 && cells[core[k].id][i] !== LEND);
        if (cand.length) cover = cand.includes(prevCover) && coverCount[prevCover] <= Math.min(...cand.map((k) => coverCount[k])) + 3 ? prevCover : cand.reduce((a, b) => (coverCount[b] < coverCount[a] ? b : a));
      }
      core.forEach((p, k) => {
        if (cells[p.id][i]) return; // 固定格不動
        if (!present[k]) return; // 休息日留空，之後標例／休息
        rows[p.id][i] = k === cover ? shift : LEND;
      });
      if (cover >= 0) { coverCount[cover]++; prevCover = cover; }
      else { uncoveredDays.push(i); prevCover = -1; }
    }

    // 支援人員補缺
    const supUsed = {};
    sups.forEach((p) => { rows[p.id] = cells[p.id].slice(); supUsed[p.id] = rows[p.id].filter((c) => c === shift).length; });
    const gapDays = [];
    const supStreak = {};
    sups.forEach((p) => (supStreak[p.id] = 0));
    let lastDay = -2;
    for (const i of uncoveredDays) {
      const cand = sups.filter((p) => !cells[p.id][i] && supUsed[p.id] < P.supportMaxDays && (i === lastDay + 1 ? supStreak[p.id] + 1 : 1) <= P.maxConsecutive);
      if (!cand.length) { gapDays.push(i + 1); lastDay = -2; sups.forEach((p) => (supStreak[p.id] = 0)); continue; }
      cand.sort((a, b) => supUsed[a.id] - supUsed[b.id] || (supStreak[b.id] > 0 ? 1 : 0) - (supStreak[a.id] > 0 ? 1 : 0));
      const s = cand[0];
      rows[s.id][i] = shift; supUsed[s.id]++;
      sups.forEach((p) => (supStreak[p.id] = p === s ? (i === lastDay + 1 ? supStreak[p.id] + 1 : 1) : 0));
      lastDay = i;
    }
    // 回傳此班固定人員的休息日（給其他班別錯開用）
    const offs = new Array(n).fill(0);
    core.forEach((p, k) => { for (let i = 0; i < n; i++) if (!presentOf(specs[k], best.combo[k], i)) offs[i]++; });
    return { ok: true, gaps: gapDays.length, gapDays, rows, specs, core, sups, supUsed, offs };
  }

  // 把固定人員的休息日標成 例 / 國定 / 補休 / 休息
  function labelRests(ctx, rows, core) {
    const { n, sundays, holidays } = ctx;
    core.forEach((p) => {
      const row = rows[p.id];
      const blocks = [[1, 14], [15, 28], [29, n]];
      const U = blocks.map(([a, b]) => { const u = []; for (let d = a; d <= b && d <= n; d++) if (!row[d - 1]) u.push(d); return u; });
      const fixedLi = blocks.map(([a, b]) => { let t = 0; for (let d = a; d <= b && d <= n; d++) if (row[d - 1] === '例') t++; return t; });
      const li = new Set();
      [0, 1].forEach((b) => {
        const m = Math.max(0, 2 - fixedLi[b]);
        const normal = U[b].filter((d) => !holidays.has(d));
        spread(normal.length >= m ? normal : U[b], m).forEach((d) => li.add(d));
      });
      const totalLi = fixedLi.reduce((s, v) => s + v, 0) + li.size;
      const rest = [].concat(U[2], U[1], U[0]).filter((d) => !li.has(d) && !holidays.has(d)).sort((a, b) => a - b);
      spread(rest, Math.max(0, sundays - totalLi)).forEach((d) => li.add(d));
      const worked = [...holidays].filter((d) => row[d - 1] === p.shift || row[d - 1] === LEND).sort((a, b) => a - b);
      const plain = [].concat(U[0], U[1], U[2]).filter((d) => !li.has(d) && !holidays.has(d)).sort((a, b) => a - b);
      const later = worked.length ? plain.filter((d) => d > worked[0]) : [];
      const comp = new Set(spread(later.length >= worked.length ? later : plain, worked.length)); // 補休盡量排在國定日之後
      U.forEach((u) => u.forEach((d) => {
        row[d - 1] = li.has(d) ? '例' : holidays.has(d) ? '國定' : comp.has(d) ? '補休' : '休息';
      }));
    });
  }

  function autoSchedule(input) {
    const ctx = makeCtx(input);
    const { n, staff } = ctx;
    const fixed = input.cells || {};
    const rng = mulberry32(input.seed || 1);
    const cells = {};
    staff.forEach((p) => (cells[p.id] = normRow(fixed[p.id], n)));
    const out = {};
    staff.forEach((p) => (out[p.id] = cells[p.id].slice()));
    const gaps = [];
    const supportUsage = {};
    const lent = {};
    const notes = [];
    let otherOff = new Array(n).fill(0);
    for (const shift of WORK) {
      const r = solveShift(ctx, shift, cells, { rng, otherOff });
      if (!r.ok) {
        const who = r.core.map((p) => p.name).join('、');
        notes.push(`${{ D: '白班', E: '小夜', N: '大夜' }[shift]}無法為 ${who} 排出合規的休息日（預假或已填的格子可能互相衝突）`);
        for (let d = 1; d <= n; d++) gaps.push({ day: d, shift });
        continue;
      }
      if (!r.core.length && !r.sups.length) notes.push(`${{ D: '白班', E: '小夜', N: '大夜' }[shift]}沒有任何人員`);
      labelRests(ctx, r.rows, r.core);
      Object.keys(r.rows).forEach((id) => (out[id] = r.rows[id]));
      r.gapDays.forEach((d) => gaps.push({ day: d, shift }));
      r.sups.forEach((p) => (supportUsage[p.id] = r.supUsed[p.id]));
      r.core.forEach((p) => { const c = out[p.id].filter((x) => x === LEND).length; if (c) lent[p.id] = c; });
      otherOff = otherOff.map((v, i) => v + (r.offs ? r.offs[i] : 0));
    }
    return { cells: out, gaps, supportUsage, lent, notes };
  }

  // 預假審核：特休優先，同類依登記先後；會讓當班缺人增加（或排不出合規休息日）的預假予以削減
  function resolvePrebooks(input) {
    const ctx = makeCtx(input);
    const { n, staff } = ctx;
    const manual = input.cells || {};
    const prebook = input.prebook || {};
    const cells = {};
    staff.forEach((p) => (cells[p.id] = normRow(manual[p.id], n)));
    const accepted = {};
    staff.forEach((p) => (accepted[p.id] = new Array(n).fill('')));
    const rejected = [];
    const at = (p) => p.prebookAt || '9999-12-31';
    const check = (shift) => solveShift(ctx, shift, cells, { rng: mulberry32(7), effort: 2 });
    for (const shift of WORK) {
      const base = check(shift);
      const g0 = base.ok ? base.gaps : n;
      const reqs = [];
      staff.forEach((p, idx) => {
        if (p.shift !== shift || p.support) return;
        normRow(prebook[p.id], n).forEach((c, i) => {
          if (c === '休假' || c === '特休') reqs.push({ p, idx, day: i + 1, code: c });
        });
      });
      reqs.sort((a, b) => (a.code === b.code ? 0 : a.code === '特休' ? -1 : 1) || (at(a.p) < at(b.p) ? -1 : at(a.p) > at(b.p) ? 1 : 0) || a.idx - b.idx || a.day - b.day);
      for (const q of reqs) {
        const row = cells[q.p.id];
        if (row[q.day - 1]) continue; // 護理長已手動填，不動
        row[q.day - 1] = q.code;
        const t = check(shift);
        if (t.ok && t.gaps <= g0) accepted[q.p.id][q.day - 1] = q.code;
        else { row[q.day - 1] = ''; rejected.push({ id: q.p.id, name: q.p.name, day: q.day, code: q.code }); }
      }
    }
    return { cells, accepted, rejected };
  }

  return { autoSchedule, resolvePrebooks, DEFAULTS, LEND };
});
