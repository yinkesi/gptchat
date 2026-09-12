#!/usr/bin/env node
/**
 * gptchat E2E 冒烟测试：针对一个运行中的服务器实例验证核心用户旅程。
 * 用法：node scripts/e2e.mjs [baseUrl]
 * 覆盖：注册/登录、房间、成员、@提及回声、API 智能体收件箱、
 *       提案-投票-共识-任务、任务更新、设备配对（同意/领取/吊销）。
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8791';
let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function client() {
  let token = null;
  return {
    setToken(t) {
      token = t;
    },
    req(method, path, body, opts = {}) {
      const headers = { 'content-type': 'application/json', 'x-gptchat-native': '1', ...(opts.headers ?? {}) };
      if (token) headers.authorization = `Bearer ${token}`;
      return fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const uniq = Date.now().toString(36);
  const alice = client();
  const bob = client();

  console.log('— 认证 —');
  let r = await alice.req('POST', '/api/v1/auth/register', {
    username: `alice_${uniq}`,
    password: 'password123',
    displayName: 'Alice',
  });
  ok('注册 alice', r.status === 201 && r.data.user?.id, JSON.stringify(r.data));
  alice.setToken(r.data.token);
  r = await bob.req('POST', '/api/v1/auth/register', { username: `bob_${uniq}`, password: 'password123' });
  bob.setToken(r.data.token);
  ok('注册 bob', r.status === 201);

  r = await alice.req('POST', '/api/v1/auth/login', { username: `alice_${uniq}`, password: 'wrongpass' });
  ok('错误密码被拒绝', r.status === 401);
  r = await alice.req('POST', '/api/v1/auth/login', { username: `alice_${uniq}`, password: 'password123' });
  ok('登录成功', r.status === 200 && r.data.token);

  console.log('— 房间与成员 —');
  r = await alice.req('POST', '/api/v1/rooms', {
    name: '小组作业',
    topic: 'GIS 分工',
    withDemoAgent: true,
  });
  const roomId = r.data.room?.id;
  ok('创建房间（含演示智能体）', r.status === 201 && roomId && r.data.room.settings.maxAgentChain === 8);

  r = await alice.req('GET', '/api/v1/users?q=bob');
  const bobId = r.data.users?.[0]?.id;
  ok('搜索用户 bob', r.status === 200 && bobId);
  r = await alice.req('POST', `/api/v1/rooms/${roomId}/members`, { username: `bob_${uniq}` });
  ok('邀请 bob 进房', r.status === 201);

  r = await bob.req('GET', `/api/v1/rooms/${roomId}`);
  ok('bob 可读房间（成员权限）', r.status === 200 && r.data.agents.length === 1);
  const echoAgent = r.data.agents[0];
  ok('演示智能体在房', echoAgent?.adapter === 'echo');

  // 未登录用户不能读房间
  const anon = client();
  r = await anon.req('GET', `/api/v1/rooms/${roomId}`);
  ok('匿名读取被拒', r.status === 401);

  console.log('— @提及与回声智能体 —');
  r = await alice.req('POST', `/api/v1/rooms/${roomId}/messages`, {
    body: '大家好，@Echo 请打个招呼，我们要开始分工了',
  });
  ok('消息发送成功且解析出提及', r.status === 201 && r.data.message.mentions.length === 1);
  await sleep(1400); // echo 延迟 600ms + 冷却 1200ms 窗口
  r = await alice.req('GET', `/api/v1/rooms/${roomId}/messages`);
  const echoReply = r.data.messages.find((m) => m.senderType === 'agent' && m.senderName === 'Echo');
  ok('回声智能体自动回复', !!echoReply, JSON.stringify(r.data.messages.map((m) => [m.senderName, m.body.slice(0, 20)])));

  console.log('— API 智能体与收件箱 —');
  r = await bob.req('POST', '/api/v1/my/agents', {
    name: 'Bob-Bot',
    kind: 'api',
    adapter: 'generic',
    description: 'bob 的 CLI 智能体',
  });
  ok('bob 创建 API 智能体', r.status === 201 && r.data.token?.startsWith('gptc_'));
  const botToken = r.data.token;
  const botId = r.data.agent.id;

  r = await bob.req('POST', `/api/v1/rooms/${roomId}/agents`, { agentId: botId });
  ok('智能体进房', r.status === 201);
  r = await bob.req('POST', `/api/v1/rooms/${roomId}/agents`, { agentId: botId });
  ok('重复进房幂等', r.status === 201);

  const bot = client();
  bot.setToken(botToken);
  r = await bot.req('GET', '/api/v1/agents/@me/rooms');
  ok('智能体查询自己所在房间', r.status === 200 && r.data.rooms.length === 1);

  // alice 提及 Bob-Bot
  r = await alice.req('POST', `/api/v1/rooms/${roomId}/messages`, { body: '@Bob-Bot 请列出你的能力' });
  ok('提及 Bob-Bot', r.status === 201 && r.data.message.mentions.some((m) => m.name === 'Bob-Bot'));

  r = await bot.req('GET', '/api/v1/agents/@me/inbox?wait=5');
  ok('收件箱长轮询收到提及', r.status === 200 && r.data.items.length >= 1);
  ok('提及内容完整', r.data.items[0]?.body.includes('请列出你的能力'));
  // peek 语义：处理完必须 ack，否则会重复投递
  r = await bot.req('POST', '/api/v1/agents/@me/inbox/ack', { ids: r.data.items.map((i) => i.inboxId) });
  ok('收件箱 ack 提交', r.status === 200);
  r = await bot.req('GET', '/api/v1/agents/@me/inbox');
  ok('ack 后不再重复投递', r.status === 200 && r.data.items.length === 0);

  // 智能体回复（带冷却）
  r = await bot.req('POST', `/api/v1/rooms/${roomId}/messages`, { body: '我可以写代码、跑分析、生成报告' });
  ok('智能体回复房间', r.status === 201);
  r = await bot.req('POST', `/api/v1/rooms/${roomId}/messages`, { body: '再发一条' });
  ok('发言冷却生效（429）', r.status === 429);

  console.log('— 提案、共识与任务 —');
  r = await alice.req('POST', `/api/v1/rooms/${roomId}/messages`, {
    body: '我提议按下面分工来：',
    proposal: {
      title: 'GIS 小组作业分工 v1',
      body: '按模块拆分，各自认领',
      tasks: [
        { title: '数据采集与清洗', assigneeName: 'Bob-Bot' },
        { title: '空间分析', assigneeName: 'Echo' },
        { title: '可视化制图' },
      ],
    },
  });
  const proposalId = r.data.message?.proposal?.id;
  ok('创建提案消息', r.status === 201 && proposalId, JSON.stringify(r.data).slice(0, 200));

  // 房间内 2 个智能体（Echo、Bob-Bot），ratio 0.5 → 需要 ceil(2×0.5)=1 票即可通过
  r = await bot.req('POST', `/api/v1/proposals/${proposalId}/vote`, {
    proposalId,
    choice: 'approve',
    comment: '分工合理',
  });
  ok('Bob-Bot 赞成后共识即时达成', r.status === 200 && r.data.proposal.status === 'accepted');
  ok('生成任务摘要', r.data.proposal.taskPreviews?.length === 3);

  r = await bob.req('GET', `/api/v1/rooms/${roomId}/tasks`);
  ok('任务列表可读', r.status === 200 && r.data.tasks.length === 3);
  const task = r.data.tasks.find((t) => t.assigneeName === 'Bob-Bot');
  ok('任务按名字指派到 Bob-Bot', !!task);

  r = await bot.req('PATCH', `/api/v1/tasks/${task.id}`, { status: 'done' });
  ok('负责智能体更新任务状态', r.status === 200 && r.data.task.status === 'done');

  // 第二个提案：测房主强制判定路径
  r = await alice.req('POST', `/api/v1/rooms/${roomId}/messages`, {
    body: '补充提案：交换第二阶段分工',
    proposal: { title: '分工 v2（交换）', body: '', tasks: [{ title: '复核成果' }] },
  });
  const p2 = r.data.message?.proposal?.id;
  r = await bob.req('POST', `/api/v1/proposals/${p2}/resolve`, { decision: 'accepted' });
  ok('非房主不能强制判定', r.status === 403);
  r = await alice.req('POST', `/api/v1/proposals/${p2}/resolve`, { decision: 'accepted' });
  ok('房主强制通过（无投票也能兜底）', r.status === 200 && r.data.proposal.status === 'accepted');

  console.log('— 重复投票/越权 —');
  r = await bot.req('POST', `/api/v1/proposals/${proposalId}/vote`, { proposalId, choice: 'reject' });
  ok('已关闭提案不能再投', r.status === 409);

  console.log('— 设备配对（跨电脑接入）—');
  const pairCode = 'XK42PQ';
  r = await anon.req('POST', '/api/v1/pairing/requests', {
    pairCode,
    machineName: 'Bob-笔记本',
    platform: 'win32',
    candidates: [
      { name: 'Claude-CLI', adapter: 'claude' },
      { name: 'Codex-CLI', adapter: 'codex' },
    ],
  });
  const requestId = r.data.requestId;
  ok('bridge 发起配对', r.status === 201 && requestId);

  r = await bob.req('POST', '/api/v1/my/devices/claim', { pairCode });
  ok('用户凭配对码认领', r.status === 200 && r.data.device?.status === 'pending');

  r = await anon.req('GET', `/api/v1/pairing/requests/${requestId}`);
  ok('bridge 轮询仍 pending', r.data.status === 'pending');

  r = await bob.req('POST', `/api/v1/my/devices/${requestId}/approve`, {
    candidates: [
      { name: 'Claude-CLI', approved: true },
      { name: 'Codex-CLI', approved: false },
    ],
  });
  ok('用户批准（仅勾选 Claude-CLI）', r.status === 200 && r.data.device?.status === 'approved');

  r = await anon.req('GET', `/api/v1/pairing/requests/${requestId}`);
  ok('bridge 领取 deviceToken 与令牌', r.status === 200 && r.data.deviceToken && r.data.grants?.length === 1);
  const grant = r.data.grants?.[0];
  r = await anon.req('GET', `/api/v1/pairing/requests/${requestId}`);
  ok('grant 仅下发一次', r.data.grants === undefined || r.data.grants === null || r.data.grants?.length === undefined);

  // 用领取到的 agent token 验证
  const bridged = client();
  bridged.setToken(grant.agentToken);
  r = await bridged.req('GET', '/api/v1/agents/@me/rooms');
  ok('配对智能体可用其令牌认证', r.status === 200);

  // 吊销后令牌立即失效
  r = await bob.req('POST', `/api/v1/my/devices/${requestId}/revoke`);
  ok('吊销设备', r.status === 200);
  r = await bridged.req('GET', '/api/v1/agents/@me/rooms');
  ok('吊销后智能体令牌失效', r.status === 401);

  console.log('— 限流与安全 —');
  const flood = client();
  let lastStatus = 0;
  for (let i = 0; i < 30; i++) {
    r = await flood.req('POST', '/api/v1/auth/login', { username: 'x', password: 'y' });
    lastStatus = r.status;
  }
  ok('登录暴力破解被限流', lastStatus === 429, `got ${lastStatus}`);

  r = await alice.req('GET', '/api/v1/my/agents');
  ok('我的智能体列表', r.status === 200);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E 执行异常:', err);
  process.exit(1);
});
