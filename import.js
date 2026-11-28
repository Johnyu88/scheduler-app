// 匯入 2A Excel(.xlsx) 班表。不需要任何套件，瀏覽器與 Node 都能用。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XlsxImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const dec = new TextDecoder();

  // ---------- 解壓 ----------
  async function unzip(buf) {
    const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = b.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('這不是 .xlsx 檔。舊版 .xls 或有密碼的檔案，請先用 Excel 另存成 .xlsx');
    const files = {};
    let p = v.getUint32(e + 16, true);
    for (let i = 0, total = v.getUint16(e + 10, true); i < total; i++) {
      const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      files[name] = { method, data: b.subarray(start, start + size) };
      p += 46 + nl + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    return async (name) => {
      const f = files[name]; if (!f) return '';
      if (f.method === 0) return dec.decode(f.data);
      if (typeof DecompressionStream === 'undefined') throw new Error('這個瀏覽器版本太舊，無法讀取 Excel，請更新瀏覽器');
      return new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    };
  }

  // ---------- XML ----------
  const unesc = (s) => s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|quot|apos|amp);/g, (m, k) => (k[0] === '#' ? String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : +k.slice(1)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[k]));
  const texts = (x) => unesc((x.replace(/<rPh[\s\S]*?<\/rPh>/g, '').match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/^<t[^>]*>|<\/t>$/g, '')).join(''));
  const attr = (a, k) => { const m = new RegExp('(?:^|\\s)' + k + '="([^"]*)"').exec(a); return m ? unesc(m[1]) : ''; };
  const colNum = (s) => s.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

  // 回傳 [{ name, rows: [[儲存格文字]] }]，隱藏的工作表略過
  async function readWorkbook(buf) {
    const get = await unzip(buf);
    const shared = ((await get('xl/sharedStrings.xml')).match(/<si>[\s\S]*?<\/si>|<si\/>/g) || []).map(texts);
    const rels = {};
    ((await get('xl/_rels/workbook.xml.rels')).match(/<Relationship\s[^>]*>/g) || []).forEach((r) => (rels[attr(r, 'Id')] = attr(r, 'Target')));
    const sheets = [];
    for (const tag of (await get('xl/workbook.xml')).match(/<sheet\s[^>]*>/g) || []) {
      if (/hidden/i.test(attr(tag, 'state'))) continue;
      const t = rels[attr(tag, 'r:id')] || '';
      const xml = await get(t.startsWith('/') ? t.slice(1) : 'xl/' + t);
      const rows = [];
      const re = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let m;
      while ((m = re.exec(xml))) {
        const ref = /^([A-Z]+)(\d+)$/.exec(attr(m[1], 'r')); if (!ref) continue;
        const type = attr(m[1], 't'), body = m[2] || '';
        const val = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        const text = type === 's' ? shared[+val] || '' : type === 'inlineStr' ? texts(body) : val == null ? '' : unesc(val);
        (rows[+ref[2] - 1] = rows[+ref[2] - 1] || [])[colNum(ref[1])] = text;
      }
      sheets.push({ name: attr(tag, 'name'), rows: Array.from(rows, (r) => Array.from(r || [], (c) => c || '')) });
    }
    return sheets;
  }

  // ---------- 班表解析 ----------
  const KNOWN = ['D', 'E', 'N', '例', '休息', '休假', '特休', '補休', '國定', '補國', '公假', '8-5', '3AB', '2A'];
  const clean = (s) => String(s || '').replace(/[\s　]/g, '');
  const normCode = (s) => {
    const t = clean(s).replace(/[Ａ-Ｚａ-ｚ０-９－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const up = t.toUpperCase();
    return KNOWN.includes(up) ? up : t;
  };

  // 找日期列：同一列中 1、2、3… 連續排在相鄰欄位，至少到 28
  function findDays(rows) {
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        let n = 0;
        while (n < 31 && Number(clean(rows[r][c + n])) === n + 1) n++;
        if (n >= 28) return { row: r, col: c, n };
      }
    }
    return null;
  }

  function parseSheet(sheet) {
    const rows = sheet.rows, head = findDays(rows);
    if (!head) return null;
    const cell = (r, c) => (rows[r] && rows[r][c]) || '';
    let nameCol = -1, levelCol = -1, start = head.row + 1;
    for (let r = Math.max(0, head.row - 2); r <= head.row + 3; r++) {
      for (let c = 0; c < head.col; c++) {
        const t = clean(cell(r, c));
        if (t === '姓名') { nameCol = c; start = Math.max(start, r + 1); }
        if (t === '職級') { levelCol = c; start = Math.max(start, r + 1); }
      }
    }
    if (nameCol < 0) nameCol = head.col - 1;
    if (nameCol < 0) return null;
    if (levelCol < 0 && nameCol > 0) levelCol = nameCol - 1;

    const title = rows.slice(0, head.row + 1).map((r) => r.join(' ')).join(' ') + ' ' + sheet.name;
    const tm = /(\d{3,4})\s*年\s*(\d{1,2})\s*月/.exec(title);
    const year = tm ? (+tm[1] < 1911 ? +tm[1] + 1911 : +tm[1]) : null;
    const month = tm ? +tm[2] : null;

    const days = (r) => Array.from({ length: head.n }, (_, i) => normCode(cell(r, head.col + i)));
    const people = [], unknown = {};
    for (let r = start; r < rows.length; r++) {
      const lead = clean(rows[r] ? rows[r].slice(0, head.col).join('') : '');
      if (/每日上班人數|備註|他單位借入/.test(lead)) break;
      const name = clean(cell(r, nameCol));
      if (!name || /公告|日期|姓名|星期|人數/.test(name) || /公告事項/.test(lead)) continue;
      if (/支援）|支援\)/.test(name)) continue; // 他單位借入的唯讀列
      const rawLevel = levelCol >= 0 ? clean(cell(r, levelCol)).toUpperCase() : '';
      const top = days(r);
      // 下一列沒有姓名，視為同一人的第二列（單位／借調標記）
      const next = r + 1 < rows.length && ['', '3AB'].includes(normCode(cell(r + 1, nameCol))) && !/每日上班人數|備註|他單位借入/.test(clean((rows[r + 1] || []).slice(0, head.col).join('')));
      const low = next ? days(r + 1) : [];
      const level = (/N[1-4]?/.exec(rawLevel) || [''])[0];
      if (!level && !top.some((c) => KNOWN.includes(c))) continue;
      // 姓名或職級下方寫「3AB」＝這個人屬於 3AB（來支援 2A 的人）
      const support = next && [nameCol, levelCol].some((c) => c >= 0 && normCode(cell(r + 1, c)) === '3AB');
      const cells = top.map((c, i) => (!support && low[i] === '3AB' ? '3AB' : c));
      cells.forEach((c) => { if (c && !KNOWN.includes(c)) unknown[c] = (unknown[c] || 0) + 1; });
      const tally = (s) => cells.filter((c) => c === s).length;
      const worked = ['D', 'E', 'N'].filter(tally).sort((a, b) => tally(b) - tally(a));
      // 整月都是借調時，從上列看原班別
      const shift = worked[0] || ['D', 'E', 'N'].find((s) => top.includes(s)) || '';
      people.push({ name, level, shift, support: !!support, extra: rawLevel.includes('*'), cells });
      if (next) r++;
    }
    return people.length ? { sheet: sheet.name, title, year, month, days: head.n, people, unknown } : null;
  }

  // 只留 2A 的工作表：名稱或表頭含 2A；整個檔案都沒標 2A 時才全部列出（標 3AB 的不列）
  function candidates(sheets) {
    const all = sheets.map(parseSheet).filter(Boolean);
    const unitOf = (p) => { const m = /(2A|3AB)\s*(護理|班表|\d{3}年|$)/i.exec(p.sheet) || /(2A|3AB)\s*(護理|班表)/i.exec(p.title); return m ? m[1].toUpperCase() : ''; };
    const mine = all.filter((p) => unitOf(p) === '2A');
    return mine.length ? mine : all.filter((p) => unitOf(p) !== '3AB');
  }

  // 把解析結果併進 2A 的儲存狀態；同名人員保留原本的設定
  function toState(old, parsed, year, month, holidays) {
    const base = old || {};
    const sameMonth = base.year === year && base.month === month;
    const byName = {};
    (base.staff || []).forEach((p) => (byName[clean(p.name)] = p));
    const cells = {};
    const staff = parsed.people.map((q, i) => {
      const o = byName[q.name];
      const p = o ? { ...o } : { id: 'x' + Date.now().toString(36) + i, name: q.name, level: q.level || 'N', support: q.support, prevShift: '' };
      if (p.restAuto) { delete p.restDays; delete p.restAuto; }
      if (q.level) p.level = q.level;
      p.shift = q.shift || p.shift || 'D';
      if (q.extra) p.extra = true;
      if (q.support) p.support = true;
      cells[p.id] = q.cells.slice();
      return p;
    });
    const st = { ...base, year, month, holidays, staff, cells, auto: {}, prebook: sameMonth ? base.prebook || {} : {}, autoReport: null, restManual: sameMonth && !!base.restManual };
    delete st.incoming;
    if (!st.restManual) st.requiredRest = 0; // 開啟時依月份與假日重算
    const removed = (base.staff || []).filter((p) => !parsed.people.some((q) => q.name === clean(p.name))).map((p) => p.name);
    return { state: st, removed };
  }

  return { readWorkbook, parseSheet, candidates, toState };
});
