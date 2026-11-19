// 关门确认检查 — 飞书长连接版（无公网依赖）
// 流程：23:00 发确认卡片到群 → WebSocket 长连接实时监听按钮点击
//      → 有人点击：立即更新卡片为已确认 + 发群文本 → 结束
//      → 未确认：每3分钟重发卡片；02:00 仍无确认 → 报警文本

import lark from '@larksuiteoapi/node-sdk';

const CHAT_ID = process.env.FEISHU_CHAT_ID;             // 群 chat_id
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const WAIT_UNTIL_UTC_HOUR = process.env.WAIT_UNTIL_UTC_HOUR; // 15 = 北京 23:00
const POLL_INTERVAL_MS = 3 * 60 * 1000;                 // 3 分钟重发
const DEADLINE_UTC_HOUR = 18;                           // UTC 18:00 = 北京 02:00 截止

// 寒暑假（与排期检查一致）——每年校历更新时改这里
const HOLIDAYS = [
  { name: '寒假', start: '2027-01-18', end: '2027-02-19' },
  { name: '暑假', start: '2027-07-19', end: '2027-09-02' },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

function bjDate() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function bjTime() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16); }
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

// ============ 卡片 ============
function buildCard() {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `🕯 关门确认（今晚 ${bjTime()} 发出）` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**一教大数据中心关门检查**\n离开的同学请确认门窗、灯、空调已关闭。\n任何一位在场的同学点击下方按钮即可完成确认。' } },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 已关门，点击确认' },
          type: 'primary',
          value: { action: 'confirm_close' },
        }],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '点击后卡片立即变为已确认；未确认前每 3 分钟重新提醒' }] },
    ],
  };
}

function buildConfirmedCard(name, timeStr) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: `✅ 已关门（${name} ${timeStr}）` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**确认人：${name}**\n**确认时间：${timeStr}**\n一教大数据中心关门确认完成，今晚提醒到此为止，晚安 🌙` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '云端实时记录 · 未确认前每3分钟重发的提醒已停止' }] },
    ],
  };
}

// ============ 主流程 ============
(async () => {
  await waitUntilTarget();
  try {
    if (!APP_ID || !APP_SECRET || !CHAT_ID) throw new Error('缺少 FEISHU_APP_ID/SECRET/CHAT_ID');
    const holiday = inHoliday(bjDate());
    if (holiday) { log(`${holiday}期间，跳过关门检查`); return; }

    const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, domain: lark.Domain.Feishu });

    // 发送卡片
    const sendResp = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: CHAT_ID, msg_type: 'interactive', content: JSON.stringify(buildCard()) },
    });
    if (sendResp.code !== 0) throw new Error(`发卡片失败 code=${sendResp.code} msg=${sendResp.msg}`);
    const messageId = sendResp.data?.message_id;
    log(`卡片已发送 message_id=${messageId}`);

    let confirmed = false;

    // 更新卡片为已确认：必须带点击事件里的 token（无 token 旧接口报 300020，已实测）
    // 更新失败时才降级发文本，正常情况确认信息只体现在卡片上
    async function markConfirmed(operatorId, timeStr, name, token) {
      let updated = false;
      if (token) {
        try {
          const upd = await client.request({
            method: 'POST',
            url: '/open-apis/interactive/v1/card/update',
            data: { token, message_id: messageId, card: buildConfirmedCard(name, timeStr) },
          });
          if (upd.code === 0) { updated = true; log('卡片已更新为已确认'); }
          else log(`卡片更新返回 code=${upd.code} msg=${upd.msg}`);
        } catch (e) { log('卡片更新异常:', e.message); }
      } else {
        log('点击事件中无 token，无法更新卡片');
      }
      if (!updated) {
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: CHAT_ID, msg_type: 'text', content: JSON.stringify({ text: `🌙 关门确认完成：${name} 于 ${timeStr} 确认（卡片更新失败，此为降级通知），今晚检查结束，大家晚安！` }) },
        }).catch(e => log('降级文本发送失败:', e.message));
      }
    }

    // 长连接监听卡片点击
    const ws = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, domain: lark.Domain.Feishu, loggerLevel: 'warn' });

    // 后台处理确认（姓名查询+卡片更新），避免阻塞回调应答导致客户端报「超时」
    async function handleConfirm(operatorId, token) {
      confirmed = true;
      const timeStr = bjTime();
      let name = '群成员';
      try {
        const u = await client.request({ method: 'GET', url: `/open-apis/contact/v3/users/${operatorId}?user_id_type=open_id` });
        const nm = u.data?.user?.name;
        log('姓名查询结果:', u.code, nm);
        if (u.code === 0 && nm) name = nm;
      } catch (e) { log('姓名查询异常:', e.message); }
      await markConfirmed(operatorId, timeStr, name, token);
    }

    const wsReady = ws.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'card.action.trigger': (data) => {
          // 立即同步应答（飞书回调窗口很短），业务逻辑放后台
          Promise.resolve().then(async () => {
            try {
              const ev = data.event || data;
              const value = ev.action?.value || {};
              const operatorId = ev.operator?.open_id || ev.operator?.operator_open_id || ev.operator_id || null;
              const token = ev.token || ev.action?.token || null;
              log('收到卡片点击 value=', JSON.stringify(value), 'operator=', operatorId, 'token=', token ? '有' : '无');
              if (value.action === 'confirm_close' && operatorId && !confirmed) {
                await handleConfirm(operatorId, token);
              }
            } catch (e) { log('处理点击事件出错:', e.message); }
          });
          return { return_code: 0, return_message: 'success' };
        },
      }),
    });
    await wsReady;
    log('长连接已建立，开始监听按钮点击');

    // 重发循环（每10秒小步检查确认状态；累计满3分钟且未确认才重发）
    let round = 0;
    let elapsed = 0;
    while (!confirmed) {
      // 截止检查：UTC 18:00（北京 02:00）
      const nowU = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
      if (nowU >= DEADLINE_UTC_HOUR) {
        log('到达 02:00 截止，仍无确认');
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: CHAT_ID, msg_type: 'text', content: JSON.stringify({ text: '⚠️ 关门确认提醒：今晚 23:00 起持续提醒无人点击确认，请值班同学人工检查一教大数据中心是否已关门！' }) },
        });
        return;
      }
      await new Promise(r => setTimeout(r, 10 * 1000));
      if (confirmed) break;
      elapsed += 10;
      if (elapsed < POLL_INTERVAL_MS / 1000) continue;
      elapsed = 0;
      round++;
      log(`round ${round}: 未确认，重发卡片`);
      const r = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: CHAT_ID, msg_type: 'interactive', content: JSON.stringify(buildCard()) },
      });
      if (r.code !== 0) log(`重发失败 code=${r.code} msg=${r.msg}`);
    }

    log('已确认，保持在线 5 分钟后退出（让后续误点/重复点击也能正常回调）');
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    process.exit(0);
  } catch (e) {
    log('ERROR:', e.message);
    process.exit(1);
  }
})();
