// 调试:检查 FAKE_TODAY 与网格匹配
import zlib from 'node:zlib';
const { execSync } = await import('node:child_process');

process.env.FAKE_TODAY = '2026-11-16';
process.env.DRY_RUN = '1';
const mod = await import('./scripts/check_schedule.mjs').catch(e => console.log('import err (expected, no top-level export):', e.message));

// 直接复用逻辑手测
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const r1 = await fetch('https://docs.qq.com/sheet/DZU90TnNFcE5wU1B0?tab=BB08J2', { headers: { 'User-Agent': UA } });
const setCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
let xsrf = '';
for (const c of setCookies) { const m = c.match(/^([^=]+)=([^;]*)/); if (m && m[1] === 'TOK') xsrf = m[2]; }
const api = `https://docs.qq.com/dop-api/get/sheet?padId=300000000%24eOtNsEpNpSPt&subId=BB08J2&startrow=0&endrow=-1&outformat=1&nowb=1&xsrf=${encodeURIComponent(xsrf)}`;
const r2 = await fetch(api, { headers: { 'User-Agent': UA, Referer: 'https://docs.qq.com/sheet/DZU90TnNFcE5wU1B0', Cookie: cookieHeader } });
const j = await r2.json();
const b64 = j.data?.initialAttributedText?.text?.[0]?.related_sheet;
const inflated = zlib.inflateSync(Buffer.from(b64, 'base64'));

function parseProto(buf, depth = 0, maxDepth = 10) {
  const out = []; let i = 0;
  while (i < buf.length) {
    let fk = 0, sh = 0, ok = false;
    while (i < buf.length) { const b = buf[i++]; fk |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) { ok = true; break; } }
    if (!ok) break;
    const f = fk >>> 3, wt = fk & 7;
    if (f === 0) break;
    if (wt === 0) { let v = 0n, s2 = 0n; while (i < buf.length) { const b = buf[i++]; v |= BigInt(b & 0x7f) << BigInt(s2.toString()); s2 += 7n; if (!(b & 0x80)) break; } out.push({ f, wt, v: Number(v) }); }
    else if (wt === 1) { out.push({ f, wt, hex: buf.slice(i, i + 8).toString('hex') }); i += 8; }
    else if (wt === 2) {
      let len = 0n, s2 = 0n;
      while (i < buf.length) { const b = buf[i++]; len |= BigInt(b & 0x7f) << BigInt(s2.toString()); s2 += 7n; if (!(b & 0x80)) break; }
      len = Number(len);
      if (len > buf.length - i) { out.push({ f, wt, bad: true }); break; }
      const chunk = buf.slice(i, i + len); i += len;
      let nested = null;
      if (depth < maxDepth) { try { nested = parseProto(chunk, depth + 1, maxDepth); } catch {} }
      out.push({ f, wt, len, nested: nested && nested.length > 0 && !nested.some(x => x.bad) ? nested : undefined, raw: chunk });
    } else if (wt === 5) { out.push({ f, wt, hex: buf.slice(i, i + 4).toString('hex') }); i += 4; }
    else break;
  }
  return out;
}
const gv = (n, f) => { const x = (n.nested || []).find(k => k.f === f); return x ? x.v : undefined; };
const tree = parseProto(inflated);
const big5 = tree[0].nested.filter(x => x.f === 5).pop();
const n19 = big5.nested.find(x => x.f === 19);
const kids = n19.nested;
const pool = kids.find(k => k.f === 5).nested.filter(x => x.f === 1).map(e => { const t = (e.nested || []).find(k => k.f === 1); return t ? t.raw.toString('utf8') : ''; });
const grid = {};
for (const cell of kids.filter(k => k.f === 6)) {
  const r = gv(cell, 1) || 0, c = gv(cell, 2) || 0;
  const f3 = (cell.nested || []).find(k => k.f === 3);
  if (f3 && f3.nested) {
    const f2 = f3.nested.find(k => k.f === 2);
    const idx = f2 && f2.nested ? gv(f2, 1) : undefined;
    if (idx !== undefined && pool[idx]) grid[`${r},${c}`] = pool[idx].trim();
  }
}
for (let r = 76; r <= 84; r++) console.log(r, JSON.stringify([0,1,2,3,4,5,6].map(c => grid[`${r},${c}`] || '')));
