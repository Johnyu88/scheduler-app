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
  const LENDS = ['3AB', '2A']; // 借調代碼：2A 人員標 3AB；3AB 人員借給 2A 標 2A。都算上班、不計入本單位人力
  const isLend = (c) => LENDS.includes(c);
  const SUPPORT_LEVELS = ['N2', 'N3', 'N4'];

  const DEFAULTS = {
    coverage: { D: 1, E: 1, N: 1 }, // 2A 每班每天 1 人（硬性）
    maxConsecutive: 6, // 連續上班上限（待確認）
  };

  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
  const dow = (y, m, d) => new Date(y, m - 1, d).getDay();
  // 某班某天需要幾人：數字＝每天固定；{weekday, off}＝平日／週末與國定假日不同
  function coverageNeed(coverage, shift, year, month, day, holidays) {
    const v = (coverage || DEFAULTS.coverage)[shift];
    if (v == null) return 1;
    if (typeof v === 'number') return v;
    const w = dow(year, month, day);
    const off = w === 0 || w === 6 || (holidays || []).includes(day);
    return off ? v.off : v.weekday;
  }
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
    if (input.incoming) P.incoming = input.incoming; // 另一單位借來的人數：{D:[每天],E:[],N:[]}
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
        const who = staff.filter((p) => !p.extra && row(p)[d - 1] === s);
        const ex = staff.filter((p) => p.extra && row(p)[d - 1] === s).length; // 特約人員：額外人力，人力不足時可補上
        const c = who.length;
        const want = Math.max(0, coverageNeed(P.coverage, s, year, month, d, input.holidays) - (((P.incoming || {})[s] || [])[d - 1] || 0));
        if (c + ex < want || c + ex > want + (ex > 0 ? 1 : 0)) add('coverage', 'error', `${month}/${d} ${SHIFT_LABEL[s]} ${c} 人，應為 ${want} 人`, null, d);
        if (P.requireSenior && c > 0 && !who.some((p) => SUPPORT_LEVELS.includes(p.level))) add('senior-mix', 'error', `${month}/${d} ${SHIFT_LABEL[s]} 沒有 N2 以上的人員`, null, d);
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
        if (WORK.includes(c) || isLend(c)) {
          streak++;
          if (streak > P.maxConsecutive && !flagged) {
            add('consecutive', 'error', `${p.name} 到 ${month}/${i + 1} 已連續上班 ${streak} 天，上限 ${P.maxConsecutive} 天`, p.id, i + 1);
            flagged = true;
          }
        } else { streak = 0; flagged = false; }
      });
      // R6b 班至少連上 2 天：不得出現「上 1 天班就休息」（月初、月底的一天受前後月影響，不檢查）
      const REST_ALL = LEGAL_REST.concat(['特休', '公假']);
      const isW = (c) => WORK.includes(c) || isLend(c);
      for (let i = 1; i < r.length - 1; i++) {
        if (isW(r[i]) && REST_ALL.includes(r[i - 1]) && REST_ALL.includes(r[i + 1])) {
          add('min-work-run', 'error', `${p.name} ${month}/${i + 1} 只上 1 天班就休息，班至少要連上 2 天`, p.id, i + 1);
        }
      }
      // R6d 除非有預約假（或特休、公假、國定假日），否則不排連休 3 天以上
      {
        const pb = ((input.prebook || {})[p.id] || []);
        let i = 0;
        while (i < r.length) {
          if (!REST_ALL.includes(r[i])) { i++; continue; }
          let j = i; while (j + 1 < r.length && REST_ALL.includes(r[j + 1])) j++;
          if (j - i + 1 >= 3) {
            let booked = false;
            for (let k = i; k <= j; k++) if (pb[k] || ['特休', '公假', '國定', '補國'].includes(r[k])) booked = true;
            if (!booked) add('long-rest', 'error', `${p.name} ${month}/${i + 1}–${month}/${j + 1} 連休 ${j - i + 1} 天，沒有預約假不排連休 3 天以上`, p.id, i + 1);
          }
          i = j + 1;
        }
      }
      // R6c 每月至少有一次連續休息 2 天
      if (r.every((c) => c) && !r.some((c, i) => i > 0 && REST_ALL.includes(c) && REST_ALL.includes(r[i - 1]))) {
        add('rest-pair', 'error', `${p.name} 本月沒有連續休息 2 天`, p.id, null);
      }
      // R7 本月應休天數
      const reqRest = p.restDays != null ? p.restDays : requiredRest; // 特約人員可以單獨設定休息天數（restDays）
      if (reqRest != null) {
        const c = count(r, MONTH_REST);
        if (c < reqRest) add('monthly-rest', 'error', `${p.name} 本月休 ${c} 日，應休 ${reqRest} 日`, p.id, null);
        if (c > reqRest) add('monthly-rest', 'error', `${p.name} 本月休 ${c} 日，超過應休 ${reqRest} 日（要多休請用特休）`, p.id, null);
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

  return { WORK, LEGAL_REST, MONTH_REST, SUPPORT_LEVELS, DEFAULTS, daysInMonth, dow, redDays, checkSchedule, LEND, LENDS, isLend, coverageNeed, checkPrebook };
});
