// 純 JS 的 Excel(.xlsx) 輸出：不需要任何套件，瀏覽器與 Node 都能用
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.Xlsx = factory(root.Rules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';
  const enc = new TextEncoder();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  // ---------- zip（不壓縮） ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const parts = [], central = []; let off = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    files.forEach((f) => {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const head = [0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0];
      parts.push(Uint8Array.from(head), name, data);
      central.push(Uint8Array.from([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(off)]), name);
      off += head.length + name.length + data.length;
    });
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = Uint8Array.from([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), 0, 0]);
    const all = parts.concat(central, [end]); const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0)); let p = 0;
    all.forEach((a) => { out.set(a, p); p += a.length; }); return out;
  }

  // ---------- 樣式 ----------
  function Styles() {
    const fonts = ['<font><sz val="12"/><name val="標楷體"/></font>'], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'];
    const fIdx = {}, flIdx = {}, xfIdx = { '': 0 };
    const get = (o) => {
      o = o || {}; const key = JSON.stringify(o); if (xfIdx[key] != null) return xfIdx[key];
      const fk = `${o.bold ? 1 : 0}|${o.color || ''}|${o.size || 12}`;
      if (fIdx[fk] == null) { fIdx[fk] = fonts.length; fonts.push(`<font>${o.bold ? '<b/>' : ''}<sz val="${o.size || 12}"/>${o.color ? `<color rgb="FF${o.color}"/>` : ''}<name val="標楷體"/></font>`); }
      let fl = 0;
      if (o.fill) { if (flIdx[o.fill] == null) { flIdx[o.fill] = fills.length; fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${o.fill}"/><bgColor indexed="64"/></patternFill></fill>`); } fl = flIdx[o.fill]; }
      xfs.push(`<xf numFmtId="0" fontId="${fIdx[fk]}" fillId="${fl}" borderId="${o.noBorder ? 0 : 1}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${o.align || 'center'}" vertical="center"${o.wrap ? ' wrapText="1"' : ''}/></xf>`);
      return (xfIdx[key] = xfs.length - 1);
    };
    const xml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF999999"/></left><right style="thin"><color rgb="FF999999"/></right><top style="thin"><color rgb="FF999999"/></top><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    return { get, xml };
  }

  // ---------- 工作表 ----------
  // sheet = { name, cells: { 'A1': {v, f, s} }, merges: ['A1:B2'], widths: {col(0-based): width}, heights: {row(1-based): h} }
  function sheetXml(sh, st) {
    const byRow = {};
    Object.keys(sh.cells).forEach((a) => { const m = /^([A-Z]+)(\d+)$/.exec(a); (byRow[+m[2]] = byRow[+m[2]] || []).push([a, m[1], sh.cells[a]]); });
    const colNum = (s) => s.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    let rows = '';
    Object.keys(byRow).map(Number).sort((a, b) => a - b).forEach((r) => {
      const cs = byRow[r].sort((x, y) => colNum(x[1]) - colNum(y[1])).map(([a, , c]) => {
        const s = st.get(c.s);
        if (c.v == null && c.f == null) return `<c r="${a}" s="${s}"/>`;
        if (typeof c.v === 'number') return `<c r="${a}" s="${s}">${c.f ? `<f>${esc(c.f)}</f>` : ''}<v>${c.v}</v></c>`;
        if (c.f) return `<c r="${a}" s="${s}" t="str"><f>${esc(c.f)}</f><v>${esc(c.v == null ? '' : c.v)}</v></c>`;
        return `<c r="${a}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
      }).join('');
      const h = sh.heights && sh.heights[r];
      rows += `<row r="${r}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cs}</row>`;
    });
    const cols = Object.keys(sh.widths || {}).map(Number).sort((a, b) => a - b).map((c) => `<col min="${c + 1}" max="${c + 1}" width="${sh.widths[c]}" customWidth="1"/>`).join('');
    const merges = (sh.merges || []).length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="3" topLeftCell="D4" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData>${merges}<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  }
  function workbook(sheets) {
    const st = Styles();
    // 先產生各表（樣式需要累積），再輸出 styles
    const sx = sheets.map((s) => sheetXml(s, st));
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: st.xml() },
    ].concat(sx.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })));
    return zip(files);
  }

  // ---------- 班表 → 工作表（版面仿照護理長現行的班表） ----------
  const FILL = { D: 'FFF2CC', E: 'FCE4D6', N: 'DDEBF7', 例: 'E2EFDA', 休息: 'E2EFDA', 國定: 'C6E0B4', 補休: 'E2EFDA', 補國: 'E2EFDA', 休假: 'E2EFDA', 特休: 'E4DFEC', 公假: 'EDEDED', '3AB': 'EADCF4', '2A': 'EADCF4' };
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const SHIFT_ORDER = { D: 0, E: 1, N: 2 };
  // st = 該單位的儲存狀態；unit = '2A' | '3AB'
  function scheduleSheet(st, unit, opt) {
    opt = opt || {};
    const n = R.daysInMonth(st.year, st.month);
    const lendCode = unit === '3AB' ? '2A' : '3AB';
    const cells = {}, merges = [], widths = { 0: 4, 1: 6, 2: 11 }, heights = { 1: 28, 2: 20 };
    const put = (a, v, s, f) => { cells[a] = { v, s, f }; };
    const first = 3, last = first + n - 1; // 0-based 欄：日期在 D.. 
    const isOff = (d) => { const w = new Date(st.year, st.month - 1, d).getDay(); return w === 0 || w === 6 || (st.holidays || []).includes(d); };
    for (let i = 0; i < n; i++) widths[first + i] = 5.2;
    const sumCols = ['例', '休息', '國定', '補國', '休假', '補休', '公假', '公差', '特休'];
    const sc0 = last + 2; // 簽名欄之後
    widths[last + 1] = 14;
    sumCols.forEach((_, i) => (widths[sc0 + i] = 6));
    const cLend = sc0 + sumCols.length, cReq = cLend + 1, cTot = cLend + 2, cD = cLend + 3;
    [cLend, cReq, cTot, cD, cD + 1, cD + 2].forEach((c) => (widths[c] = 8));
    // 標題與日期列
    put('B1', `苗栗醫院 ${unit} 護理人員 ${st.year - 1911} 年 ${st.month} 月班表`, { bold: true, size: 16, noBorder: true, align: 'left' });
    merges.push(`B1:${colName(last)}1`);
    put('B2', '日期/星期', { bold: true, fill: 'D9D9D9' }); merges.push('B2:C2');
    put('C2', null, { fill: 'D9D9D9' });
    put('B3', '職級', { bold: true, fill: 'D9D9D9' }); put('C3', '姓名', { bold: true, fill: 'D9D9D9' });
    for (let d = 1; d <= n; d++) {
      const c = colName(first + d - 1), red = isOff(d);
      put(`${c}2`, d, { bold: true, fill: red ? 'F8CBAD' : 'D9D9D9' });
      put(`${c}3`, WD[new Date(st.year, st.month - 1, d).getDay()], { bold: true, fill: red ? 'F8CBAD' : 'D9D9D9' });
    }
    put(`${colName(last + 1)}2`, '經確認無誤後\n同意簽名', { wrap: true, fill: 'D9D9D9', bold: true }); merges.push(`${colName(last + 1)}2:${colName(last + 1)}3`);
    put(`${colName(last + 1)}3`, null, { fill: 'D9D9D9' });
    sumCols.forEach((t, i) => { put(`${colName(sc0 + i)}2`, t, { bold: true, fill: 'D9D9D9' }); put(`${colName(sc0 + i)}3`, null, { fill: 'D9D9D9' }); merges.push(`${colName(sc0 + i)}2:${colName(sc0 + i)}3`); });
    [[cLend, '借調'], [cReq, '本月應休'], [cTot, '合計共休'], [cD, 'D'], [cD + 1, 'E'], [cD + 2, 'N']].forEach(([c, t]) => { put(`${colName(c)}2`, t, { bold: true, fill: 'D9D9D9' }); put(`${colName(c)}3`, null, { fill: 'D9D9D9' }); merges.push(`${colName(c)}2:${colName(c)}3`); });
    put('B4', '公告事項', { bold: true, noBorder: true, align: 'left' });
    put('D4', `本月應休 ${st.requiredRest} 天；${lendCode} 為借調（人員用不到的日子支援另一單位）`, { noBorder: true, align: 'left' }); merges.push(`D4:${colName(last)}4`);
    // 人員列：每人兩列（上列＝班別，下列＝借調標記）
    const staff = st.staff.slice().sort((a, b) => (a.extra ? 1 : 0) - (b.extra ? 1 : 0) || SHIFT_ORDER[a.shift] - SHIFT_ORDER[b.shift]);
    let r = 5; const top0 = r;
    const cnt = { D: new Array(n).fill(0), E: new Array(n).fill(0), N: new Array(n).fill(0) };
    staff.forEach((p, idx) => {
      const row = ((st.cells || {})[p.id] || []).slice(0, n); while (row.length < n) row.push('');
      put(`A${r}`, idx + 1, {}); merges.push(`A${r}:A${r + 1}`); put(`A${r + 1}`, null, {});
      put(`B${r}`, p.level + (p.extra ? '*' : ''), {}); merges.push(`B${r}:B${r + 1}`); put(`B${r + 1}`, null, {});
      put(`C${r}`, p.name, { bold: true }); merges.push(`C${r}:C${r + 1}`); put(`C${r + 1}`, null, {});
      for (let d = 1; d <= n; d++) {
        const c = colName(first + d - 1), v = row[d - 1] || '';
        const lent = R.isLend(v);
        const shown = lent ? p.shift : v;
        put(`${c}${r}`, shown, { fill: FILL[shown] || (isOff(d) && !shown ? 'F2F2F2' : undefined) });
        put(`${c}${r + 1}`, lent ? v : null, { fill: lent ? FILL[v] : undefined, size: 10, bold: true });
        if (!lent && cnt[v]) cnt[v][d - 1]++;
      }
      put(`${colName(last + 1)}${r}`, null, {}); merges.push(`${colName(last + 1)}${r}:${colName(last + 1)}${r + 1}`); put(`${colName(last + 1)}${r + 1}`, null, {});
      const rng = `$D${r}:$${colName(last)}${r}`;
      const count = (codes) => row.filter((c) => codes.includes(c)).length;
      sumCols.forEach((t, i) => { put(`${colName(sc0 + i)}${r}`, count([t]), {}, `COUNTIF(${rng},"${t}")`); merges.push(`${colName(sc0 + i)}${r}:${colName(sc0 + i)}${r + 1}`); put(`${colName(sc0 + i)}${r + 1}`, null, {}); });
      const rest = count(['例', '休息', '國定', '補國', '休假', '補休']);
      put(`${colName(cLend)}${r}`, row.filter((c) => R.isLend(c)).length, {}, `COUNTIF($D${r + 1}:$${colName(last)}${r + 1},"${lendCode}")`); merges.push(`${colName(cLend)}${r}:${colName(cLend)}${r + 1}`); put(`${colName(cLend)}${r + 1}`, null, {});
      put(`${colName(cReq)}${r}`, p.extra ? null : st.requiredRest, {}); merges.push(`${colName(cReq)}${r}:${colName(cReq)}${r + 1}`); put(`${colName(cReq)}${r + 1}`, null, {});
      const sumF = [0, 1, 2, 3, 4, 5].map((i) => `${colName(sc0 + i)}${r}`).join('+');
      put(`${colName(cTot)}${r}`, rest, {}, sumF); merges.push(`${colName(cTot)}${r}:${colName(cTot)}${r + 1}`); put(`${colName(cTot)}${r + 1}`, null, {});
      ['D', 'E', 'N'].forEach((s, i) => { put(`${colName(cD + i)}${r}`, row.filter((c) => c === s).length, {}, `COUNTIF($D${r}:$${colName(last)}${r},"${s}")`); merges.push(`${colName(cD + i)}${r}:${colName(cD + i)}${r + 1}`); put(`${colName(cD + i)}${r + 1}`, null, {}); });
      heights[r] = 22; heights[r + 1] = 15;
      r += 2;
    });
    // 每日上班人數（本單位，不含借調出去的人；另列他單位借入）
    r += 1;
    const incoming = st.incoming || {};
    ['D', 'E', 'N'].forEach((s, k) => {
      if (k === 0) put(`A${r}`, `${unit}\n每日上班人數`, { wrap: true, bold: true });
      merges.push(`A${r + k}:B${r + k}`); put(`A${r + k}`, k === 0 ? `${unit} 每日上班人數` : null, { bold: true, wrap: true });
      put(`C${r + k}`, s, { bold: true, fill: FILL[s] });
      for (let d = 1; d <= n; d++) put(`${colName(first + d - 1)}${r + k}`, cnt[s][d - 1], {});
    });
    r += 3;
    const hasIn = ['D', 'E', 'N'].some((s) => (incoming[s] || []).some((x) => x));
    if (hasIn) {
      ['D', 'E', 'N'].forEach((s, k) => {
        merges.push(`A${r + k}:B${r + k}`); put(`A${r + k}`, k === 0 ? '他單位借入' : null, { bold: true });
        put(`C${r + k}`, s, { bold: true, fill: FILL[s] });
        for (let d = 1; d <= n; d++) put(`${colName(first + d - 1)}${r + k}`, (incoming[s] || [])[d - 1] || 0, {});
      });
      r += 3;
    }
    put(`A${r}`, '備註：D＝白班　E＝小夜　N＝大夜　例＝例假　國定＝國定假日　補休＝補休　' + lendCode + '＝借調另一單位（標在人員下方一列）　*＝特約人員（額外人力，不計入每班人數）', { noBorder: true, align: 'left' });
    merges.push(`A${r}:${colName(last)}${r}`);
    return { name: opt.name || `${unit} ${st.year - 1911}年${st.month}月`, cells, merges, widths, heights };
  }

  return { zip, workbook, scheduleSheet, colName };
});
