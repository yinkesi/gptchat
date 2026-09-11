import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadState, saveState, type BridgeState } from './config.js';
import { discover } from './discover.js';
import { startPairing } from './pairing.js';
import { runRuntime } from './runtime.js';

const HELP = `
gptchat-bridge —— 把本机 CLI 智能体接入 gptchat 群聊

用法:
  gptchat-bridge connect --server <url>   首次接入：探测 → 本机确认 → 配对 → 上线
  gptchat-bridge run                      用已保存的身份重新上线
  gptchat-bridge discover                 只读探测本机可接入的智能体
  gptchat-bridge status                   查看本机接入状态
  gptchat-bridge logout                   清除本机保存的接入身份

隐私与安全:
  · 探测只检查「CLI 是否安装」，不读取任何配置内容或历史
  · 接入需要两次同意：本机确认 + 网页端批准
  · 本地 CLI 调用不经 shell，消息内容不会被执行
`;

function log(msg: string): void {
  console.log(`[bridge] ${msg}`);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function cmdConnect(args: Record<string, string | boolean>): Promise<void> {
  const server = String(args.server ?? process.env.GPTCHAT_SERVER ?? '');
  if (!server) {
    console.error('缺少 --server，例如: gptchat-bridge connect --server https://chat.example.com');
    process.exit(1);
  }
  const assumeYes = args.yes === true;

  log(`探测本机智能体（只读，不读取任何配置内容）…`);
  const state0 = loadState();
  const found = discover(state0?.customAdapters ?? []);
  if (found.length === 0) {
    log('未发现已安装的 CLI 智能体（支持 claude / codex / gemini，或自定义 customAdapters）。');
    log('仍可继续配对（例如稍后手动补充）。');
  } else {
    for (const a of found) log(`  发现: ${a.name} (${a.adapter})`);
  }

  let picked = found;
  if (!assumeYes) {
    const ans = await ask(
      `要接入以上 ${found.length} 个智能体吗？[Y/n/序号如 1,3]（Y=全部，n=取消）: `,
    );
    const t = ans.trim().toLowerCase();
    if (t === 'n' || t === 'no') {
      log('已取消。');
      return;
    }
    if (/^[\d,]+$/.test(t)) {
      const idx = t.split(',').map((s) => Number(s.trim()) - 1).filter((i) => i >= 0 && i < found.length);
      picked = idx.map((i) => found[i]!);
    }
    if (picked.length === 0) {
      log('未选择任何智能体，已取消。');
      return;
    }
  }

  log(`向服务器发起配对: ${server}`);
  const pairing = await startPairing(server, hostname(), picked);
  console.log('\n──────────────────────────────────────');
  console.log(`  配对码:  ${pairing.pairCode}`);
  console.log(`  请在网页端「设备接入 → 接入新电脑」输入此码，`);
  console.log(`  并勾选允许接入的智能体。等待批准中…`);
  console.log('──────────────────────────────────────\n');

  const approved = await pairing.waitApproved();
  const agents: BridgeState['agents'] = {};
  for (const g of approved.grants) {
    const adapter = picked.find((p) => p.name === g.name)?.adapter ?? g.adapter;
    agents[g.agentId] = { name: g.name, token: g.agentToken, adapter };
    log(`已接入: ${g.name}`);
  }
  saveState({
    server,
    deviceToken: approved.deviceToken,
    deviceId: approved.deviceId,
    machineName: hostname(),
    agents,
    customAdapters: state0?.customAdapters,
  });
  log('身份已保存到 ~/.gptchat/bridge.json（权限 0600）。正在上线…');
  runRuntime({
    server,
    deviceToken: approved.deviceToken,
    agents,
    customAdapters: state0?.customAdapters ?? [],
    log,
  });
}

function cmdRun(): void {
  const state = loadState();
  if (!state?.deviceToken || Object.keys(state.agents ?? {}).length === 0) {
    console.error('本机尚未接入。先运行: gptchat-bridge connect --server <url>');
    process.exit(1);
  }
  log(`服务器: ${state.server}`);
  runRuntime({
    server: state.server,
    deviceToken: state.deviceToken,
    agents: state.agents as Record<string, { name: string; token: string; adapter: string }>,
    customAdapters: state.customAdapters ?? [],
    log,
  });
}

function cmdDiscover(): void {
  const found = discover(loadState()?.customAdapters ?? []);
  if (found.length === 0) {
    log('未发现可接入的 CLI 智能体。');
    return;
  }
  for (const a of found) log(`${a.name}  (${a.adapter})`);
}

function cmdStatus(): void {
  const s = loadState();
  if (!s) {
    log('未配置。');
    return;
  }
  log(`服务器: ${s.server}`);
  log(`设备: ${s.machineName} (${s.deviceId ?? '未配对'})`);
  for (const a of Object.values(s.agents ?? {})) log(`  智能体: ${a.name} (${a.adapter})`);
}

function cmdLogout(): void {
  const s = loadState();
  if (s) {
    saveState({ ...s, deviceToken: undefined, deviceId: undefined, agents: {} });
  }
  log('已清除本机接入身份。');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  console.log('gptchat-bridge v0.1.0');
  switch (cmd) {
    case 'connect':
      await cmdConnect(parseArgs(rest));
      break;
    case 'run':
      cmdRun();
      break;
    case 'discover':
      cmdDiscover();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'logout':
      cmdLogout();
      break;
    default:
      console.log(HELP);
  }
}

void main().catch((err) => {
  console.error('[bridge] 错误:', err instanceof Error ? err.message : err);
  process.exit(1);
});
