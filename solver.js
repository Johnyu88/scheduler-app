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
  const isLend = R.isLend;

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
      year, month, n, sundays,
      need: input.requiredRest == null ? 0 : input.requiredRest,
      holidays: new Set(input.holidays || []),
      holidayList: input.holidays || [],
      lend: input.lendCode || LEND,
      lendNeedsSenior: !!input.lendNeedsSenior,
      lendOnly: !!input.lendTouched || (input.staff || []).some((p) => !p.extra && p.lendable), // 名冊有勾「支援他單位」的人，才會被借出
      out: input.out || {}, // 要借給另一單位的人數：{D:[每天],E:[],N:[]}
      incoming: Object.fromEntries(Object.entries(input.incoming || {}).map(([k, v]) => [k, v.slice()])), // 另一單位已確定借來的人數（手動或自動）；特約人員也算進來
      coverage: (input.params || {}).coverage,
      requireSenior: !!(input.params || {}).requireSenior,
      staff: staff.filter((p) => !p.extra),
      extras: staff.filter((p) => p.extra),
      P: Object.assign({}, DEFAULTS, input.params || {}),
    };
  }

  // 一位固定人員的限制條件
  function spec(ctx, p, row) {
    const { n, need } = ctx;
    const fixedOff = row.map((c) => !!c && c !== p.shift && !isLend(c));
    const forced = row.map((c) => c === p.shift || isLend(c));
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
    // rr＝目前連續休息天數；rfix＝這段連休含預約／已填的休息；sys＝這段連休中系統排的天數
    const rec = (d, used, streak, b1, b2, o28, rr, pair, rfix, sys) => {
      if (++nodes > 6000) return false;
      if (d > n) return used === sp.Rn && pair;
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
      if (sp.fixedOff[i]) {
        if (streak === 1 && d > 2) return false; // 上 1 天班就休息
        return rec(d + 1, used, 0, b1, b2, o28, rr + 1, pair || rr > 0, true, sys);
      }
      if (sp.forced[i]) return streak + 1 > P.maxConsecutive ? false : rec(d + 1, used, streak + 1, b1, b2, o28, 0, pair, false, 0);
      const canOn = streak + 1 <= P.maxConsecutive && !(d === 1 && sp.blocked1);
      // 除非有預約假，否則不排出連休 3 天以上：系統排的休息，這段連休最多 2 天；含預約假時整段最多 (預約天數 + 2) 天
      const canOff = used < sp.Rn && !(streak === 1 && d > 2) && (sys + 1 <= 2);
      const base = left ? (sp.Rn - used) / left : 0;
      const pOff = streak >= P.softStreak ? 0.9 : streak < 2 ? base * 0.3 : base;
      const opts = [];
      if (canOn) opts.push('on');
      if (canOff) opts.push('off');
      if (opts.length === 2 && rng() < pOff) opts.reverse();
      for (const o of opts) {
        if (o === 'on') { if (rec(d + 1, used, streak + 1, b1, b2, o28, 0, pair, false, 0)) return true; }
        else {
          off[i] = true;
          if (rec(d + 1, used + 1, 0, b1 + (d <= 14 ? 1 : 0), b2 + (d >= 15 && d <= 28 ? 1 : 0), o28 + (d <= 28 ? 1 : 0), rr + 1, pair || rr > 0, rfix, sys + 1)) return true;
          off[i] = false;
        }
      }
      return false;
    };
    return rec(1, 0, sp.streak0, 0, 0, 0, 0, false, false, 0) ? off.slice() : null;
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
    const poolSize = Math.min(160, 40 + 12 * core.length) * effort;
    const pools = specs.map((sp) => genPool(ctx, sp, rng, poolSize));
    const failed = pools.findIndex((pl) => !pl.length);
    const supCap = sups.reduce((s, p) => s + Math.max(0, P.supportMaxDays - cells[p.id].filter((c) => c === shift).length), 0);
    const otherOff = opts.otherOff || new Array(n).fill(0);

    const presentOf = (sp, off, i) => !sp.fixedOff[i] && !off[i];
    const incAt = (i) => ((ctx.incoming[shift] || [])[i] || 0);
    const outAt = (i) => ((ctx.out[shift] || [])[i] || 0);
    const ownAt = (i) => Math.max(0, R.coverageNeed(ctx.coverage, shift, ctx.year, ctx.month, i + 1, ctx.holidayList) - incAt(i));
    const reqAt = (i) => ownAt(i) + outAt(i);
    const isSenior = (p) => R.SUPPORT_LEVELS.includes(p.level);
    const evalCombo = (combo) => {
      let uncovered = 0, overlap = 0, noSenior = 0, ownShort = 0, outShort = 0;
      for (let i = 0; i < n; i++) {
        const pres = combo.map((o, k) => (presentOf(specs[k], o, i) ? k : -1)).filter((k) => k >= 0);
        const own = ownAt(i);
        const os = Math.max(0, own - pres.length);
        ownShort += os;
        outShort += Math.max(0, own + outAt(i) - pres.length) - os;
        if (ctx.requireSenior && pres.length >= 1 && !pres.some((k) => isSenior(core[k]))) noSenior++;
        const offs = combo.filter((o, k) => !presentOf(specs[k], o, i)).length;
        overlap += offs * otherOff[i];
      }
      uncovered = ownShort + outShort;
      // 本單位自己缺人最重；借給另一單位的缺口次之
      return { uncovered, cost: 1000 * Math.max(0, ownShort - supCap) + 12 * ownShort + 300 * outShort + 25 * overlap + 400 * noSenior };
    };

    let best = null;
    if (failed >= 0) {
      return { ok: false, gaps: n, rows: null, specs, core, sups };
    }
    if (!core.length) best = { combo: [], uncovered: n };
    else {
      const total = pools.reduce((s, pl) => s * pl.length, 1);
      const limit = 1500 * effort;
      if (total <= limit) { // 組合不多：全部列舉
        for (let t = 0; t < total; t++) {
          let idx = t; const combo = pools.map((pl) => { const o = pl[idx % pl.length]; idx = Math.floor(idx / pl.length); return o; });
          const e = evalCombo(combo);
          if (!best || e.cost < best.cost) best = { combo, cost: e.cost, uncovered: e.uncovered };
        }
      } else { // 組合太多：隨機起點 + 逐人換型態的爬山法
        for (let r = 0; r < 4 * effort; r++) {
          let combo = pools.map((pl) => pl[Math.floor(rng() * pl.length)]);
          let cur = evalCombo(combo);
          for (let sweep = 0; sweep < 8; sweep++) {
            let improved = false;
            const order = combo.map((_, k) => k).sort(() => rng() - 0.5);
            for (const k of order) {
              let bk = combo[k], bc = cur;
              for (const o of pools[k]) {
                if (o === combo[k]) continue;
                const trial = combo.slice(); trial[k] = o;
                const e = evalCombo(trial);
                if (e.cost < bc.cost) { bc = e; bk = o; }
              }
              if (bk !== combo[k]) { combo = combo.slice(); combo[k] = bk; cur = bc; improved = true; }
            }
            if (!improved) break;
          }
          if (!best || cur.cost < best.cost) best = { combo, cost: cur.cost, uncovered: cur.uncovered };
          if (best.uncovered === 0 && best.cost < 25 * 3) break;
        }
      }
    }

    // 寫入列：固定人員
    const rows = {};
    core.forEach((p) => (rows[p.id] = cells[p.id].slice()));
    const coverCount = core.map(() => 0);
    const lendCnt = new Array(n).fill(0);
    const coverLen = new Array(n).fill(0);
    const supFilled = new Array(n).fill(0);
    let prevCover = [];
    const uncoveredDays = []; // {i, short}
    for (let i = 0; i < n; i++) {
      const need = reqAt(i);
      const present = core.map((p, k) => presentOf(specs[k], best.combo[k], i));
      const covers = [];
      core.forEach((p, k) => { if (cells[p.id][i] === shift) covers.push(k); });
      const cand = present.map((v, k) => (v ? k : -1)).filter((k) => k >= 0 && !covers.includes(k) && !isLend(cells[core[k].id][i]));
      const rank = (k) => coverCount[k] * 2 + (prevCover.includes(k) ? 0 : 1) + (ctx.lendOnly && core[k].lendable ? 1000 : 0); // 多出來的人盡量是可借調的人，才有地方去
      cand.sort((x, y) => rank(x) - rank(y));
      const pickN = Math.max(0, need - covers.length);
      const chosen = cand.slice(0, pickN);
      if (ctx.requireSenior) { // 至少 1 位 N2 以上
        const all = covers.concat(chosen);
        if (all.length && !all.some((k) => isSenior(core[k]))) {
          const s1 = cand.slice(pickN).find((k) => isSenior(core[k]));
          if (s1 != null && chosen.length) chosen[chosen.length - 1] = s1;
        }
      }
      const canLend = (k) => !ctx.lendOnly || core[k].lendable;
      const Lw = Math.max(0, covers.length + chosen.length - ownAt(i));
      if (ctx.lendOnly && Lw > 0) { // 要借出的人數盡量由勾選「支援他單位」的人擔任
        const spare = cand.slice(pickN).filter(canLend);
        for (let q = chosen.length - 1; q >= 0 && spare.length; q--) {
          if (chosen.filter(canLend).length >= Lw) break;
          if (!canLend(chosen[q])) chosen[q] = spare.shift();
        }
      }
      const allCover = covers.concat(chosen);
      // 超出本單位需要的人數 = 借給另一單位的人；盡量借出 N2 以上（若規定），並保留本單位至少 1 位 N2 以上
      let lendSel = [];
      const L = Math.max(0, allCover.length - ownAt(i));
      if (L > 0) {
        const pool = chosen.filter(canLend);
        for (let q = 0; q < L && pool.length; q++) {
          const keepsSenior = (k) => !ctx.requireSenior || allCover.filter((x) => x !== k && !lendSel.includes(x)).some((x) => isSenior(core[x]));
          const ok = pool.filter(keepsSenior);
          const pref = ok.filter((k) => (ctx.lendNeedsSenior ? isSenior(core[k]) : true));
          const pickK = (pref.length ? pref : ok.length ? ok : pool)[0];
          lendSel.push(pickK); pool.splice(pool.indexOf(pickK), 1);
        }
      }
      const ownCover = allCover.filter((k) => !lendSel.includes(k));
      lendCnt[i] = lendSel.length; coverLen[i] = allCover.length;
      core.forEach((p, k) => {
        if (cells[p.id][i]) return; // 固定格不動
        if (!present[k]) return; // 休息日留空，之後標例／休息
        rows[p.id][i] = ownCover.includes(k) ? shift : canLend(k) ? ctx.lend : '特休'; // 多餘的人：可借調→支援另一單位；否則休假
      });
      allCover.forEach((k) => coverCount[k]++);
      prevCover = allCover;
      const short = need - allCover.length;
      if (short > 0) uncoveredDays.push({ i, short });
    }

    // 支援人員補缺
    const supUsed = {};
    sups.forEach((p) => { rows[p.id] = cells[p.id].slice(); supUsed[p.id] = rows[p.id].filter((c) => c === shift).length; });
    const gapDays = [];
    const supStreak = {};
    sups.forEach((p) => (supStreak[p.id] = 0));
    let lastDay = -2;
    for (const { i, short } of uncoveredDays) {
      for (let q = 0; q < short; q++) {
        const cand = sups.filter((p) => !cells[p.id][i] && rows[p.id][i] !== shift && supUsed[p.id] < P.supportMaxDays && (i === lastDay + 1 ? supStreak[p.id] + 1 : 1) <= P.maxConsecutive);
        if (!cand.length) continue;
        cand.sort((a, b) => supUsed[a.id] - supUsed[b.id] || (supStreak[b.id] > 0 ? 1 : 0) - (supStreak[a.id] > 0 ? 1 : 0));
        const s = cand[0];
        rows[s.id][i] = shift; supUsed[s.id]++; supFilled[i]++;
        sups.forEach((p) => (supStreak[p.id] = p === s ? (i === lastDay + 1 ? supStreak[p.id] + 1 : 1) : (rows[p.id][i] === shift ? supStreak[p.id] + 1 : 0)));
      }
      lastDay = i;
    }
    const ownGap = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      ownGap[i] = Math.max(0, ownAt(i) - (coverLen[i] - lendCnt[i]) - supFilled[i]);
      for (let q = 0; q < ownGap[i]; q++) gapDays.push(i + 1);
    }
    // 回傳此班固定人員的休息日（給其他班別錯開用）
    const offs = new Array(n).fill(0);
    core.forEach((p, k) => { for (let i = 0; i < n; i++) if (!presentOf(specs[k], best.combo[k], i)) offs[i]++; });
    return { ok: true, gaps: gapDays.length, gapDays, rows, specs, core, sups, supUsed, offs, ownGap, lendCnt };
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
      const worked = [...holidays].filter((d) => row[d - 1] === p.shift || isLend(row[d - 1])).sort((a, b) => a - b);
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
    const gapMap = {}, lentMap = {};
    // 特約人員（額外人力）先排：她上班的日子，該班本單位需要的人數少 1（例如小夜 5 人，她在時固定人員 4 人 + 她）
    ctx.extras.forEach((p) => {
      const row = normRow(fixed[p.id], n);
      const ectx = { ...ctx, need: p.restDays != null ? p.restDays : ctx.need };
      const sp = spec(ectx, p, row);
      const pool = genPool(ectx, sp, rng, 40);
      if (!pool.length) { notes.push(`特約人員 ${p.name} 無法排出合規的休息日（預假或已填的格子可能互相衝突）`); out[p.id] = row; return; }
      const pat = pool[Math.floor(rng() * pool.length)];
      const rows = { [p.id]: row.map((c, i) => (c ? c : pat[i] ? '' : p.shift)) };
      labelRests(ectx, rows, [p]);
      out[p.id] = rows[p.id];
      if (!ctx.incoming[p.shift]) ctx.incoming[p.shift] = new Array(n).fill(0);
      else ctx.incoming[p.shift] = ctx.incoming[p.shift].slice(0, n);
      rows[p.id].forEach((c, i) => { if (c === p.shift) ctx.incoming[p.shift][i] = (ctx.incoming[p.shift][i] || 0) + 1; });
    });
    let otherOff = new Array(n).fill(0);
    for (const shift of WORK) {
      const r = solveShift(ctx, shift, cells, { rng, otherOff, effort: input.effort || 3 });
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
      gapMap[shift] = r.ownGap;
      lentMap[shift] = new Array(n).fill(0); // 系統自動借出（合格者）的人數
      r.core.forEach((p) => out[p.id].forEach((c, i) => {
        if (c === ctx.lend && !cells[p.id][i] && (!ctx.lendNeedsSenior || R.SUPPORT_LEVELS.includes(p.level))) lentMap[shift][i]++;
      }));
      r.sups.forEach((p) => (supportUsage[p.id] = r.supUsed[p.id]));
      r.core.forEach((p) => { const c = out[p.id].filter((x) => isLend(x)).length; if (c) lent[p.id] = c; });
      otherOff = otherOff.map((v, i) => v + (r.offs ? r.offs[i] : 0));
    }
    return { cells: out, gaps, supportUsage, lent, notes, gapMap, lentMap };
  }

  // 兩個單位一起排：A 缺人的日子由 B 借人，B 缺人由 A 借；也接受手動借調（借出方在自己的班表直接標借調代碼）
  // units = [{ name, ...autoSchedule 的輸入, lendCode, lendNeedsSenior }, 另一單位]
  // 單次嘗試：回傳 {r, score}，score 越小越好（缺人 ×1000 + 違規數）
  function jointTry(units, t) {
    const us = units.map((u, k) => ({ ...u, seed: (u.seed || 1) + t * 7 + k, effort: 3 }));
    const r = jointOnce(us);
    const bad = (u, res) => R.checkSchedule({ ...u, cells: res.cells, incoming: res.incoming }).filter((i) => i.level === 'error' && ['senior-mix', 'coverage'].includes(i.rule)).length;
    return { r, score: (r.A.gaps.length + r.B.gaps.length) * 1000 + bad(us[0], r.A) + bad(us[1], r.B) };
  }
  function jointSchedule(units, opts) {
    // 多試幾個種子，挑缺人最少（其次違規最少）的結果；排滿或超過時間預算就結束
    opts = opts || {};
    const tries = opts.tries || 5;
    const budget = opts.budgetMs || 40000;
    const t0 = Date.now();
    let best = null;
    for (let t = 0; t < tries; t++) {
      if (best && Date.now() - t0 > budget) break;
      const x = jointTry(units, t);
      if (!best || x.score < best.score) best = x;
      if (best.score === 0) break;
    }
    return best.r;
  }
  function jointOnce(units) {
    const [A, B] = units;
    const n = R.daysInMonth(A.year, A.month);
    const zero = () => ({ D: new Array(n).fill(0), E: new Array(n).fill(0), N: new Array(n).fill(0) });
    // 手動借調：借出方人員手動標的借調代碼，視為借給對方同班別的人力
    const manualIn = (from, to) => {
      const m = zero();
      (from.staff || []).forEach((p) => {
        if (p.extra || !m[p.shift]) return;
        const row = (from.cells || {})[p.id] || [];
        row.forEach((c, i) => { if (c === from.lendCode && !((from.auto || {})[p.id] || [])[i] && i < n) m[p.shift][i]++; });
      });
      return m;
    };
    const mA = manualIn(B, A), mB = manualIn(A, B); // mA：B 手動借給 A 的人數
    const keepManual = (u) => { // 只保留手動填的格子，系統上次排的重算
      const cells = {};
      (u.staff || []).forEach((p) => { const r = ((u.cells || {})[p.id] || []).slice(0, n); const a = ((u.auto || {})[p.id]) || []; cells[p.id] = r.map((c, i) => (a[i] ? '' : c)); });
      return cells;
    };
    const cA = keepManual(A), cB = keepManual(B);
    let outA = zero(), outB = zero(); // 要借給對方的人數
    let rA, rB;
    for (let round = 0; round < 3; round++) {
      rA = autoSchedule({ ...A, cells: cA, incoming: mA, out: outA });
      rB = autoSchedule({ ...B, cells: cB, incoming: mB, out: outB });
      const nA = zero(), nB = zero(); // A 缺的 → B 借出；B 缺的 → A 借出
      WORK.forEach((s) => { for (let i = 0; i < n; i++) { nB[s][i] = (rA.gapMap[s] || [])[i] || 0; nA[s][i] = (rB.gapMap[s] || [])[i] || 0; } });
      const same = JSON.stringify(nA) === JSON.stringify(outA) && JSON.stringify(nB) === JSON.stringify(outB);
      outA = nA; outB = nB;
      if (same) break;
    }
    // 實際借到的人數 = min(對方缺口, 對方可借出的合格人數)；沒借到的才是真正缺人
    const loans = [];
    const gapsA = [], gapsB = [];
    const incA = zero(), incB = zero();
    WORK.forEach((s) => {
      for (let i = 0; i < n; i++) {
        const gA = ((rA.gapMap[s] || [])[i]) || 0, gB = ((rB.gapMap[s] || [])[i]) || 0;
        const fromB = Math.min(gA, (rB.lentMap[s] || [])[i] || 0), fromA = Math.min(gB, (rA.lentMap[s] || [])[i] || 0);
        if (fromB) { incA[s][i] = fromB; loans.push({ from: B.name, to: A.name, shift: s, day: i + 1, n: fromB }); }
        if (fromA) { incB[s][i] = fromA; loans.push({ from: A.name, to: B.name, shift: s, day: i + 1, n: fromA }); }
        for (let q = 0; q < gA - fromB; q++) gapsA.push({ day: i + 1, shift: s });
        for (let q = 0; q < gB - fromA; q++) gapsB.push({ day: i + 1, shift: s });
      }
    });
    const addManual = (inc, man) => WORK.forEach((s) => { for (let i = 0; i < n; i++) inc[s][i] += man[s][i]; });
    addManual(incA, mA); addManual(incB, mB);
    return { A: { ...rA, gaps: gapsA, incoming: incA }, B: { ...rB, gaps: gapsB, incoming: incB }, loans };
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

  return { autoSchedule, jointSchedule, jointTry, resolvePrebooks, DEFAULTS, LEND };
});
