// 会议排期检查 — 腾讯文档 → 飞书通知
// 纯 Node 内置模块，无第三方依赖
// 逻辑：读排期表 → 未来3天有活动 → 飞书通知（有活动才发；出错必告警）

import zlib from 'node:zlib';

// ============ 配置 ============
const DOC_PAGE_URL = 'https://docs.qq.com/sheet/DZU90TnNFcE5wU1B0?tab=BB08J2';
const SHEET_SUB_ID = 'BB08J2';          // 「会议排期」tab
const PAD_ID_ENC = '300000000%24eOtNsEpNpSPt';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 列定义（0-based）：A=日期 B=星期 C=上午 D=下午 E=晚上 F=临时调整 G=联系人
const COL = { DATE: 0, WEEK: 1, AM: 2, PM: 3, EVE: 4, CHANGE: 5, CONTACT: 6 };
const SLOTS = [
  [COL.AM, '上午（08:00—12:00）'],
  [COL.PM, '下午（14:00—18:00）'],
  [COL.EVE, '晚上（18:30—22:00）'],
];

// 寒暑假（不含首尾当天也跳过；整段时间不发排期通知）——每年校历更新时改这里
const HOLIDAYS = [
  { name: '寒假', start: '2027-01-18', end: '2027-02-19' },
  { name: '暑假', start: '2027-07-19', end: '2027-09-02' },
];

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const NOTIFY_TYPE = process.env.FEISHU_NOTIFY_TYPE || 'open_id';   // open_id / chat_id
const NOTIFY_ID = process.env.FEISHU_NOTIFY_ID;

// 23:00 档需要锚定准点：GitHub cron 可能提前触发，等待到目标时刻
const WAIT_UNTIL_UTC_HOUR = process.env.WAIT_UNTIL_UTC_HOUR; // 如 "15"

// ============ 工具 ============
const log = (...a) => console.log(new Date().toISOString(), ...a);

function beijingDate(offsetDays = 0) {
  // 北京时间 = UTC+8；取当天日期字符串 YYYY-MM-DD
  // FAKE_TODAY 仅调试用：模拟"今天"为指定日期（取其北京时间中午，避免时区偏移）
  const t = process.env.FAKE_TODAY
    ? Date.parse(process.env.FAKE_TODAY + 'T12:00:00+08:00')
    : Date.now();
  return new Date(t + (8 * 3600 + offsetDays * 86400) * 1000).toISOString().slice(0, 10);
}
function inHoliday(dateStr) {
  for (const h of HOLIDAYS) if (dateStr >= h.start && dateStr <= h.end) return h.name;
  return null;
}

async function waitUntilTarget() {
  if (!WAIT_UNTIL_UTC_HOUR) return;
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(Number(WAIT_UNTIL_UTC_HOUR), 0, 0, 0);
  const ms = target.getTime() - now.getTime();
  if (ms > 0 && ms < 40 * 60 * 1000) {
    log(`waiting ${Math.round(ms / 1000)}s until ${WAIT_UNTIL_UTC_HOUR}:00 UTC ...`);
    await new Promise(r => setTimeout(r, ms));
  }
}

// ============ 腾讯文档读取 ============
async function fetchSheetGrid() {
  // 1) 拿首页 cookie（TOK 即 xsrf）
  const r1 = await fetch(DOC_PAGE_URL, { headers: { 'User-Agent': UA } });
  if (!r1.ok) throw new Error(`页面请求失败 HTTP ${r1.status}`);
  const setCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
  let xsrf = '';
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m && m[1] === 'TOK') xsrf = m[2];
  }
  if (!xsrf) throw new Error('未获取到 xsrf(TOK) cookie');

  // 2) 拉全表数据
  const api = `https://docs.qq.com/dop-api/get/sheet?padId=${PAD_ID_ENC}&subId=${SHEET_SUB_ID}&startrow=0&endrow=-1&outformat=1&nowb=1&xsrf=${encodeURIComponent(xsrf)}`;
  const r2 = await fetch(api, { headers: { 'User-Agent': UA, 'Referer': DOC_PAGE_URL, 'Cookie': cookieHeader } });
  if (!r2.ok) throw new Error(`get/sheet 请求失败 HTTP ${r2.status}`);
  const j = await r2.json();
  const retcode = j.retcode ?? j.data?.retcode;
  if (retcode !== 0) throw new Error(`get/sheet retcode=${retcode}`);
  const b64 = j.data?.initialAttributedText?.text?.[0]?.related_sheet;
  if (!b64) throw new Error('响应中无 related_sheet 数据（接口结构可能已变更）');

  // 3) base64 → zlib → protobuf 解析
  const inflated = zlib.inflateSync(Buffer.from(b64, 'base64'));
  return decodeSheet(inflated);
}

// --- protobuf wire format ---
function parseProto(buf, depth = 0, maxDepth = 10) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let fk = 0, sh = 0, ok = false;
    while (i < buf.length) {
      const b = buf[i++]; fk |= (b & 0x7f) << sh; sh += 7;
      if (!(b & 0x80)) { ok = true; break; }
    }
    if (!ok) break;
    const f = fk >>> 3, wt = fk & 7;
    if (f === 0) break;
    if (wt === 0) {
      let v = 0n, s2 = 0n;
      while (i < buf.length) { const b = buf[i++]; v |= BigInt(b & 0x7f) << BigInt(s2.toString()); s2 += 7n; if (!(b & 0x80)) break; }
      out.push({ f, wt, v: Number(v) });
    } else if (wt === 1) { out.push({ f, wt, hex: buf.slice(i, i + 8).toString('hex') }); i += 8; }
    else if (wt === 2) {
      let len = 0n, s2 = 0n;
      while (i < buf.length) { const b = buf[i++]; len |= BigInt(b & 0x7f) << BigInt(s2.toString()); s2 += 7n; if (!(b & 0x80)) break; }
      len = Number(len);
      if (len > buf.length - i) { out.push({ f, wt, bad: true }); break; }
      const chunk = buf.slice(i, i + len); i += len;
      let nested = null;
      if (depth < maxDepth) { try { nested = parseProto(chunk, depth + 1, maxDepth); } catch { /* ignore */ } }
      out.push({ f, wt, len, nested: nested && nested.length > 0 && !nested.some(x => x.bad) ? nested : undefined, raw: chunk });
    } else if (wt === 5) { out.push({ f, wt, hex: buf.slice(i, i + 4).toString('hex') }); i += 4; }
    else break;
  }
  return out;
}
const gv = (n, f) => { const x = (n.nested || []).find(k => k.f === f); return x ? x.v : undefined; };

function decodeSheet(inflated) {
  const tree = parseProto(inflated);
  const n1 = tree[0].nested;
  const big5 = n1.filter(x => x.f === 5).pop();
  const n19 = big5.nested.find(x => x.f === 19);
  const kids = n19.nested;

  // 字符串池
  const poolRec = kids.find(k => k.f === 5);
  const pool = poolRec.nested.filter(x => x.f === 1).map(e => {
    const t = (e.nested || []).find(k => k.f === 1);
    return t ? t.raw.toString('utf8') : '';
  });

  // 单元格网格
  const grid = {};
  let maxR = -1;
  for (const cell of kids.filter(k => k.f === 6)) {
    const r = gv(cell, 1) || 0;
    const c = gv(cell, 2) || 0;
    const f3 = (cell.nested || []).find(k => k.f === 3);
    if (f3 && f3.nested) {
      const f2 = f3.nested.find(k => k.f === 2);
      const idx = f2 && f2.nested ? gv(f2, 1) : undefined;
      if (idx !== undefined && pool[idx]) {
        grid[`${r},${c}`] = pool[idx].trim();
        if (r > maxR) maxR = r;
      }
    }
  }
  if (maxR < 0) throw new Error('解析失败：网格为空');
  return { grid, maxR };
}

// ============ 排期汇总 ============
function collectUpcoming(grid, maxR) {
  const days = [beijingDate(0), beijingDate(1), beijingDate(2)]; // 今天/明天/后天
  const result = [];
  for (const day of days) {
    const holiday = inHoliday(day);
    if (holiday) { result.push({ day, holiday, items: [] }); continue; }
    let rowIdx = -1;
    for (let r = 0; r <= maxR; r++) {
      if (grid[`${r},${COL.DATE}`] === day) { rowIdx = r; break; }
    }
    const items = [];
    if (rowIdx >= 0) {
      for (const [col, label] of SLOTS) {
        const v = grid[`${rowIdx},${col}`];
        if (v) items.push({ slot: label, text: v });
      }
      const change = grid[`${rowIdx},${COL.CHANGE}`];
      const contact = grid[`${rowIdx},${COL.CONTACT}`];
      result.push({ day, holiday: null, items, change, contact, week: grid[`${rowIdx},${COL.WEEK}`] || '' });
    } else {
      result.push({ day, holiday: null, items: [], missing: true });
    }
  }
  return result;
}

function fmtMdyyyymmdd(s) {
  const [y, m, d] = s.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function buildMessage(upcoming) {
  const nowBj = new Date(Date.now() + 8 * 3600 * 1000);
  const hh = String(nowBj.getUTCHours()).padStart(2, '0');
  const mm = String(nowBj.getUTCMinutes()).padStart(2, '0');
  const title = `📅 大数据中心会议排期提醒（${fmtMdyyyymmdd(beijingDate(0))} ${hh}:${mm}）`;
  const hasAny = upcoming.some(u => u.items.length > 0 || u.change);
  if (!hasAny) return null; // 未来3天无活动 → 不发

  const lines = [title, '', `未来3天（${fmtMdyyyymmdd(beijingDate(0))}～${fmtMdyyyymmdd(beijingDate(2))}）安排如下：`, ''];
  for (const u of upcoming) {
    if (u.holiday) { lines.push(`【${fmtMdyyyymmdd(u.day)}】${u.holiday}期间，无需检查`); continue; }
    if (u.missing) { lines.push(`【${fmtMdyyyymmdd(u.day)}】⚠️ 排期表中未找到该日期行`); continue; }
    if (u.items.length === 0 && !u.change) { lines.push(`【${fmtMdyyyymmdd(u.day)} ${u.week}】无活动`); continue; }
    lines.push(`【${fmtMdyyyymmdd(u.day)} ${u.week}】`);
    for (const it of u.items) lines.push(`  · ${it.slot.split('（')[0]}：${it.text}`);
    if (u.change) lines.push(`  ⚠️ 调整说明：${u.change}`);
    if (u.contact) lines.push(`  联系人：${u.contact}`);
  }
  return lines.join('\n');
}

// ============ 飞书发送 ============
async function sendFeishu(text) {
  const tkResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const tk = await tkResp.json();
  if (tk.code !== 0) throw new Error(`获取 tenant_access_token 失败 code=${tk.code} msg=${tk.msg}`);
  const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + NOTIFY_TYPE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk.tenant_access_token}` },
    body: JSON.stringify({ receive_id: NOTIFY_ID, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const r = await resp.json();
  if (r.code !== 0) throw new Error(`发消息失败 code=${r.code} msg=${r.msg}`);
  log('feishu message sent ok');
}

// ============ 主流程 ============
(async () => {
  await waitUntilTarget();
  try {
    if (!APP_ID || !APP_SECRET || !NOTIFY_ID) {
      if (process.env.DRY_RUN === '1') log('[DRY_RUN] 未配置飞书凭据，仅测试读取');
      else throw new Error('缺少环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_NOTIFY_ID');
    }
    log('fetching schedule ...');
    const { grid, maxR } = await fetchSheetGrid();
    log(`grid ok: rows=${maxR + 1}`);
    const upcoming = collectUpcoming(grid, maxR);
    const msg = buildMessage(upcoming);
    log('message preview:\n' + (msg || '(无活动，不发送)'));
    if (msg && process.env.DRY_RUN === '1') log('[DRY_RUN] 跳过发送');
    else if (msg) await sendFeishu(msg);
    log('done');
  } catch (e) {
    log('ERROR:', e.message);
    // 异常自报
    try {
      if (APP_ID && APP_SECRET && NOTIFY_ID) {
        await sendFeishu(`🚨 会议排期检查出错（${new Date().toISOString()}）：${e.message}\n请人工查看排期表：${DOC_PAGE_URL}`);
      }
    } catch (e2) { log('告警发送也失败:', e2.message); }
    process.exit(1);
  }
})();
