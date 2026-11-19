// 关门确认卡片回调 Worker
// 接收飞书卡片按钮回调 → 写 KV 确认状态 → HTTP 响应实时更新卡片
// GET /status 供 GitHub Actions 轮询确认状态

const CONFIRM_KEY = 'close_confirm';

function json(resp, status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// 兼容 v1 / v2 回调结构，提取 open_id
function extractOperator(body) {
  // v2 (schema 2.0): event.operator.open_id 或 event.operator.operator_open_id
  const ev = body.event || {};
  const op = ev.operator || {};
  return op.open_id || op.operator_open_id || op.user_id || ev.operator_id || null;
}

function extractActionValue(body) {
  const ev = body.event || {};
  return ev.action?.value || null;
}

// 已确认状态卡片
function buildConfirmedCard(name, timeStr) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `✅ 已关门（${name} ${timeStr}）` },
      template: 'green',
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '一教大数据中心关门确认完成，今晚提醒到此为止，晚安 🌙' },
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: '此确认由云端系统实时记录' }],
        },
      ],
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------- 飞书卡片回调 ----------
    if (url.pathname === '/callback' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json(null, 400, { error: 'bad json' }); }

      // 回调地址验证（配置回调 URL 时飞书发的验证请求）
      if (body.type === 'url_challenge' && body.challenge) {
        return json(null, 200, { challenge: body.challenge });
      }

      const actionValue = extractActionValue(body);
      const operatorId = extractOperator(body);
      const eventId = body.header?.event_id || body.event_id || null;

      // 幂等：同一 event 只处理一次
      if (eventId) {
        const seen = await env.KV.get(`evt:${eventId}`);
        if (seen) {
          // 已处理过，返回已确认卡片
          const prev = JSON.parse(seen);
          return json(null, 200, {
            return_code: 0, return_message: 'success',
            new_card: buildConfirmedCard(prev.name || 'unknown', prev.time || ''),
          });
        }
      }

      if (actionValue && actionValue.action === 'confirm_close' && operatorId) {
        const timeStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16).replace('T', '');
        // 查确认人姓名（失败则用 open_id 兜底）
        let name = operatorId;
        try {
          const tkResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
          });
          const tk = await tkResp.json();
          if (tk.code === 0) {
            const uResp = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${operatorId}?user_id_type=open_id`, {
              headers: { Authorization: `Bearer ${tk.tenant_access_token}` },
            });
            const u = await uResp.json();
            if (u.code === 0 && u.data?.user?.name) name = u.data.user.name;
          }
        } catch { /* 兜底 open_id */ }

        const record = { confirmed: true, operator: operatorId, name, time: timeStr, ts: Date.now() };
        await env.KV.put(CONFIRM_KEY, JSON.stringify(record));
        if (eventId) await env.KV.put(`evt:${eventId}`, JSON.stringify(record), { expirationTtl: 86400 });
        console.log('confirmed by', name, 'at', timeStr);

        // HTTP 响应中直接返回新卡片 → 飞书实时更新卡片
        return json(null, 200, {
          return_code: 0,
          return_message: 'success',
          new_card: buildConfirmedCard(name, timeStr),
        });
      }

      // 其他回调：默认应答（不更新卡片）
      return json(null, 200, { return_code: 0, return_message: 'success' });
    }

    // ---------- 状态查询（GitHub Actions 轮询） ----------
    if (url.pathname === '/status' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token || token !== env.STATUS_TOKEN) {
        return json(null, 401, { error: 'unauthorized' });
      }
      const raw = await env.KV.get(CONFIRM_KEY);
      if (!raw) return json(null, 200, { confirmed: false });
      const rec = JSON.parse(raw);
      // 只认今晚的确认（北京时间每天 0 点后视为过期）
      const dayKey = new Date(rec.ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      if (dayKey !== todayKey) {
        // 昨天的确认 → 清理并报未确认
        await env.KV.delete(CONFIRM_KEY);
        return json(null, 200, { confirmed: false, note: 'expired' });
      }
      return json(null, 200, { confirmed: true, name: rec.name, time: rec.time });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json(null, 200, { ok: true, ts: Date.now() });
    }

    return json(null, 404, { error: 'not found' });
  },
};
