// 排班規則引擎。純函式、無相依，瀏覽器與 Node 都能跑。
// 規則來源與確認狀態見 docs/rules/。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WORK = ['D', 'E', 'N'];
  const SHIFT_LABEL = { D: '白班', E: '小夜', N: '大夜' };
  // 法定休息計算（4 週 8 日）採用的代碼；待與法規逐條核對
  const LEGAL_REST = ['例', '休息', '國定', '補國', '補休', '休假'];
  // 「本月應休」計算採用的代碼（班表上的合計共休包含休假）
  const MONTH_REST = ['例', '休息', '國定', '補國', '補休', '休假']; // 特休、公假另計，不算在內
  const LEND = '3AB'; // 固定人員當天支援 3AB：算上班，不計入 2A 人力
  const SUPPORT_LEVELS = ['N2', 'N3', 'N4'];

  const DEFAULTS = {
    coverage: { D: 1, E: 1, N: 1 }, // 2A 每班每天 1 人（硬性）
    maxConsecutive: 6, // 連續上班上限（待確認）
  };

  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
  const dow = (y, m, d) => new Date(y, m - 1, d).getDay();
  // 本月應休 = 日曆上的紅字日：週六、週日，加上落在平日的國定假日
  function redDays(year, month, holidays) {
    const n = daysInMonth(year, month);
    const hol = new Set(holidays || []);
    let c = 0;
    for (let d = 1; d <= n; d++) {
      const w = dow(year, month, d);
      if (w === 0 || w === 6 || hol.has(d)) c++;
    }
    return c;
  }
  const count = (arr, codes) => arr.filter((c) => codes.includes(c)).length;

  function checkSchedule(input) {
    const { year, month, staff, cells, requiredRest } = input;
    const P = Object.assign({}, DEFAULTS, input.params || {});
    P.coverage = Object.assign({}, DEFAULTS.coverage, (input.params || {}).coverage);
    const n = daysInMonth(year, month);
    const issues = [];
    const add = (rule, level, msg, staffId, day) => issues.push({ rule, level, msg, staffId: staffId || null, day: day || null });
    const row = (p) => {
      const r = (cells[p.id] || []).slice(0, n);
      while (r.length < n) r.push('');
      return r;
    };

    // R1 每班每天人數
    for (let d = 1; d <= n; d++) {
      for (const s of WORK) {
        const c = staff.filter((p) => row(p)[d - 1] === s).length;
        if (c !== P.coverage[s]) add('coverage', 'error', `${month}/${d} ${SHIFT_LABEL[s]} ${c} 人，應為 ${P.coverage[s]} 人`, null, d);
      }
    }

    for (const p of staff) {
      const r = row(p);
      // R2 純白、純小夜、純大夜
      r.forEach((c, i) => {
        if (WORK.includes(c) && c !== p.shift) add('pure-shift', 'error', `${p.name} ${month}/${i + 1} 排了 ${c}，本月班別應為 ${p.shift}`, p.id, i + 1);
      });
      // 支援人員（3AB 護理師）的例假、休息日由其所屬單位班表判斷，這裡只檢查班別與職級
      if (p.support) {
        if (!SUPPORT_LEVELS.includes(p.level)) add('support-level', 'error', `${p.name} 是 ${p.level}，支援 2A 至少要 N2`, p.id, null);
        continue;
      }
      // R3 上月班別不同，交界至少休 1 日
      if (p.prevShift && p.prevShift !== p.shift && WORK.includes(r[0])) {
        add('boundary', 'error', `${p.name} 上月是 ${p.prevShift}、本月是 ${p.shift}，${month}/1 必須休假`, p.id, 1);
      }
      // R4 每 2 週至少 2 日例假（以 1–14、15–28 日為固定區間）
      for (const [a, b] of [[1, 14], [15, 28]]) {
        if (n < b) continue;
        const c = count(r.slice(a - 1, b), ['例']);
        if (c < 2) add('biweekly', 'error', `${p.name} ${month}/${a}–${b} 只有 ${c} 日例假，每 2 週至少 2 日`, p.id, a);
      }
      // R5 每 4 週至少 8 日休息（1–28 日）
      if (n >= 28) {
        const c = count(r.slice(0, 28), LEGAL_REST);
        if (c < 8) add('fourweek', 'error', `${p.name} ${month}/1–28 只有 ${c} 日休息，每 4 週至少 8 日`, p.id, 1);
      }
      // R6 連續上班天數
      let streak = p.prevStreak || 0;
      let flagged = false;
      r.forEach((c, i) => {
        if (WORK.includes(c) || c === LEND) {
          streak++;
          if (streak > P.maxConsecutive && !flagged) {
            add('consecutive', 'error', `${p.name} 到 ${month}/${i + 1} 已連續上班 ${streak} 天，上限 ${P.maxConsecutive} 天`, p.id, i + 1);
            flagged = true;
          }
        } else { streak = 0; flagged = false; }
      });
      // R7 本月應休天數
      if (requiredRest != null) {
        const c = count(r, MONTH_REST);
        if (c < requiredRest) add('monthly-rest', 'error', `${p.name} 本月休 ${c} 日，應休 ${requiredRest} 日`, p.id, null);
        if (c > requiredRest) add('monthly-rest', 'error', `${p.name} 本月休 ${c} 日，超過應休 ${requiredRest} 日（要多休請用特休）`, p.id, null);
      }
      // R8 支援人員職級
      if (p.support && !SUPPORT_LEVELS.includes(p.level)) {
        add('support-level', 'error', `${p.name} 是 ${p.level}，支援 2A 至少要 N2`, p.id, null);
      }
    }
    return issues;
  }

  // 預假檢查：截止日、一個六日、不得超過應休
  function checkPrebook(input) {
    const { year, month, requestedAt, staff, prebook, requiredRest } = input;
    const n = daysInMonth(year, month);
    const issues = [];
    const add = (rule, msg, staffId) => issues.push({ rule, level: 'error', msg, staffId: staffId || null, day: null });
    const deadline = new Date(year, month - 2, 8, 23, 59, 59);
    const dl = `${deadline.getFullYear()}/${deadline.getMonth() + 1}/8`;
    for (const p of staff) {
      const r = (prebook[p.id] || []).slice(0, n);
      const when = p.prebookAt || requestedAt;
      if (when && r.some((c) => c) && new Date(when + 'T00:00:00') > deadline) {
        add('prebook-deadline', `${p.name} 登記日 ${when} 已超過截止日（${dl}）`, p.id);
      }
      let units = 0;
      let total = 0;
      for (let d = 1; d <= n; d++) {
        if (r[d - 1] !== '休假') continue; // 特休不計入
        total++;
        const w = dow(year, month, d);
        if (w === 6) units++;
        else if (w === 0) {
          const prevIsSat = d > 1 && r[d - 2] === '休假' && dow(year, month, d - 1) === 6;
          if (!prevIsSat) units++;
        }
      }
      if (units > 1) add('prebook-weekend', `${p.name} 預約了 ${units} 個六日，每月最多 1 個（週六、週日可分開或連續）`, p.id);
      if (requiredRest != null && total > requiredRest) add('prebook-total', `${p.name} 預約休假 ${total} 日，超過應休 ${requiredRest} 日`, p.id);
    }
    return issues;
  }

  return { WORK, LEGAL_REST, MONTH_REST, SUPPORT_LEVELS, DEFAULTS, daysInMonth, dow, redDays, checkSchedule, LEND, checkPrebook };
});
