import type { Mention } from '@gptchat/shared';
import { MAX_MENTIONS } from '@gptchat/shared';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从消息正文中解析 @提及。
 * 规则：
 *  - 仅匹配「空白或行首 + @ + 名称」；名称按长度优先（避免 "Bot" 抢走 "Bot-Long"）；
 *  - 大小写不敏感；去重；上限 MAX_MENTIONS；
 *  - 名称必须与房间内智能体精确匹配 —— 服务器永远只投递给真实存在的智能体。
 * 纯函数，便于单元测试。
 */
export function parseMentions(body: string, roomAgents: ReadonlyArray<{ id: string; name: string }>): Mention[] {
  if (!body.includes('@') || roomAgents.length === 0) return [];
  const sorted = [...roomAgents].sort((a, b) => b.name.length - a.name.length);
  // @ 前不能是字母/数字/@/.（避免误伤邮箱）；允许中文标点、空白等作为前导边界
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_@.])@(${sorted.map((a) => escapeRegExp(a.name)).join('|')})(?=$|[^\\w\\u4e00-\\u9fa5-])`,
    'gmiu',
  );
  const seen = new Set<string>();
  const byName = new Map(sorted.map((a) => [a.name.toLowerCase(), a]));
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const name = m[1]!.toLowerCase();
    const agent = byName.get(name);
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      if (seen.size >= MAX_MENTIONS) break;
    }
  }
  return [...seen].map((id) => {
    const agent = roomAgents.find((a) => a.id === id)!;
    return { agentId: id, name: agent.name };
  });
}
