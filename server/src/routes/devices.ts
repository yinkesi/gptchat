import { Router } from 'express';
import {
  MAX_AGENTS_PER_USER,
  MAX_DEVICES_PER_USER,
  PAIRING_TTL_MS,
  PairRequestInput,
  type PairCandidate,
  type PairRequestView,
} from '@gptchat/shared';
import { getDb, audit } from '../db.js';
import { hashToken, newAgentToken, newId, newOpaqueToken } from '../crypto.js';
import { badRequest, forbidden, gone, notFound } from '../errors.js';
import {
  dbOf,
  deviceById,
  requireUser,
  signDeviceJwt,
  type AgentRow,
  type DeviceRow,
} from '../middleware/auth.js';
import { messageLimiter, pairingLimiter, validated, z, param } from '../middleware/common.js';

const PairClaimInput = z.object({ pairCode: z.string().regex(/^[A-Z0-9]{6}$/) }).strict();
const PairApproveInput = z
  .object({
    candidates: z
      .array(z.object({ name: z.string().min(1).max(64), approved: z.boolean() }))
      .min(1)
      .max(12),
  })
  .strict();
import { decryptJson, encryptJson } from '../util/crypt.js';
import type { ChatContext } from '../core/chat.js';

interface StoredGrant {
  name: string;
  adapter: string;
  model?: string;
  agentToken: string;
  agentId: string;
}

function rowToView(d: DeviceRow, withCandidates: boolean): PairRequestView & { id: string; ownerId: string | null } {
  let candidates: PairCandidate[] = [];
  try {
    const parsed: unknown = JSON.parse(d.candidates);
    if (Array.isArray(parsed)) candidates = parsed as PairCandidate[];
  } catch {
    candidates = [];
  }
  return {
    id: d.id,
    pairCode: d.pair_code,
    machineName: d.machine_name,
    platform: d.platform,
    status: d.status as PairRequestView['status'],
    requestedAt: d.requested_at,
    candidates: withCandidates ? candidates : [],
    ownerId: d.owner_id,
  };
}

export function devicesRouter(ctx: ChatContext): Router {
  const router = Router();

  // ---------- 匿名侧（新电脑上的 bridge） ----------

  /** bridge 发起配对：只提交本机探测到的候选名称，不携带任何隐私数据。 */
  router.post('/pairing/requests', pairingLimiter, async (req, res) => {
    const input = validated(req, PairRequestInput);
    const db = getDb();
    const id = newOpaqueToken(24); // 该 ID 即轮询凭据（256bit 随机）
    const now = Date.now();
    db.prepare(
      `INSERT INTO devices (id, machine_name, platform, pair_code, status, candidates, requested_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      id,
      input.machineName,
      input.platform,
      input.pairCode,
      JSON.stringify(
        input.candidates.map((c) => ({ name: c.name, adapter: c.adapter, model: c.model, approved: false })),
      ),
      now,
      now + PAIRING_TTL_MS,
    );
    audit(db, 'device', id, 'pairing.request', { machine: input.machineName }, req.ip);
    res.status(201).json({ requestId: id, expiresAt: now + PAIRING_TTL_MS });
  });

  /** bridge 轮询配对结果；批准后一次性下发设备 JWT 与智能体令牌。 */
  router.get('/pairing/requests/:id', pairingLimiter, async (req, res) => {
    const db = getDb();
    const device = deviceById(db, param(req, 'id'));
    if (!device || (device.status === 'pending' && device.expires_at < Date.now())) throw gone('配对请求不存在或已过期');

    if (device.status === 'pending') {
      res.json({ status: 'pending' });
      return;
    }
    if (device.status === 'revoked') {
      res.json({ status: 'revoked' });
      return;
    }

    // approved
    const grants = device.grants_delivered ? null : readGrants(device);
    if (grants) {
      db.prepare('UPDATE devices SET grants_delivered = 1, grants_pending = NULL WHERE id = ?').run(device.id);
    }
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), device.id);
    res.json({
      status: 'approved',
      deviceToken: signDeviceJwt(device.id),
      deviceId: device.id,
      /** 仅首次下发：agentToken 明文 */
      grants: grants ?? undefined,
    });
  });

  // ---------- 用户侧（web 控制台，需登录） ----------

  /** 用户凭配对码认领设备请求（把「屏幕上看到的码」与账号绑定）。 */
  router.post('/my/devices/claim', requireUser, messageLimiter(10, 60_000), async (req, res) => {
    const body = validated(req, PairClaimInput);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const device = db
      .prepare(
        "SELECT * FROM devices WHERE pair_code = ? AND status = 'pending' AND expires_at > ? ORDER BY requested_at LIMIT 1",
      )
      .get(body.pairCode, Date.now()) as unknown as DeviceRow | undefined;
    if (!device) throw notFound('没有找到匹配的配对请求（可能已过期）');
    const owned = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE owner_id = ?').get(p.userId) as { n: number };
    if (owned.n >= MAX_DEVICES_PER_USER) throw badRequest(`最多接入 ${MAX_DEVICES_PER_USER} 台设备`);
    db.prepare('UPDATE devices SET owner_id = ? WHERE id = ?').run(p.userId, device.id);
    audit(db, 'user', p.userId, 'pairing.claim', { device: device.id }, req.ip);
    const updated = deviceById(db, device.id)!;
    res.json({ device: rowToView(updated, true) });
  });

  router.get('/my/devices', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const rows = dbOf(req)
      .prepare('SELECT * FROM devices WHERE owner_id = ? ORDER BY requested_at DESC')
      .all(p.userId) as unknown as DeviceRow[];
    res.json({ devices: rows.map((d) => rowToView(d, true)) });
  });

  /** 用户批准：勾选要接入的候选智能体 → 创建 bridge 智能体并生成令牌（加密等待领取）。 */
  router.post('/my/devices/:id/approve', requireUser, async (req, res) => {
const body = validated(req, PairApproveInput);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const device = deviceById(db, param(req, 'id'));
    if (!device || device.owner_id !== p.userId) throw notFound('设备不存在');
    if (device.status !== 'pending') throw badRequest('该设备已处理过');
    if (device.expires_at < Date.now()) throw gone('配对请求已过期');

    const candidates = parseCandidates(device);
    const grants: StoredGrant[] = [];
    for (const c of candidates) {
      const decision = body.candidates.find((b) => b.name === c.name);
      c.approved = decision?.approved === true;
      if (c.approved) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?').get(p.userId) as { n: number };
        if (count.n >= MAX_AGENTS_PER_USER) throw badRequest(`智能体数量已达上限（${MAX_AGENTS_PER_USER}）`);
        const agentId = newId('agent');
        const agentToken = newAgentToken();
        db.prepare(
          `INSERT INTO agents (id, owner_id, device_id, name, kind, adapter, model, token_hash, status, created_at)
           VALUES (?, ?, ?, ?, 'bridge', ?, ?, ?, 'offline', ?)`,
        ).run(agentId, p.userId, device.id, c.name, c.adapter, c.model ?? null, hashToken(agentToken), Date.now());
        grants.push({ name: c.name, adapter: c.adapter, model: c.model, agentToken, agentId });
        c.agentId = agentId;
      }
    }
    if (grants.length === 0) throw badRequest('未选择任何要接入的智能体');

    db.prepare(
      "UPDATE devices SET status = 'approved', approved_at = ?, grants_pending = ?, grants_delivered = 0 WHERE id = ?",
    ).run(Date.now(), encryptJson(grants), device.id);
    audit(db, 'user', p.userId, 'pairing.approve', { device: device.id, agents: grants.length }, req.ip);

    const updated = deviceById(db, device.id)!;
    res.json({ device: rowToView(updated, true) });
  });

  /** 吊销：立即断开该设备所有智能体。 */
  router.post('/my/devices/:id/revoke', requireUser, async (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const device = deviceById(db, param(req, 'id'));
    if (!device || device.owner_id !== p.userId) throw notFound('设备不存在');
    db.prepare("UPDATE devices SET status = 'revoked', token_hash = NULL, grants_pending = NULL WHERE id = ?").run(device.id);
    const agents = db.prepare('SELECT * FROM agents WHERE device_id = ?').all(device.id) as unknown as AgentRow[];
    for (const a of agents) {
      db.prepare("UPDATE agents SET token_hash = NULL, status = 'offline' WHERE id = ?").run(a.id);
      ctx.hub.dropAgentSockets(a.id);
      ctx.presence.offline(a.id);
    }
    audit(db, 'user', p.userId, 'pairing.revoke', { device: device.id }, req.ip);
    const updated = deviceById(db, device.id)!;
    res.json({ device: rowToView(updated, true) });
  });

  router.delete('/my/devices/:id', requireUser, async (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const device = deviceById(db, param(req, 'id'));
    if (!device || device.owner_id !== p.userId) throw notFound('设备不存在');
    const agents = db.prepare('SELECT * FROM agents WHERE device_id = ?').all(device.id) as unknown as AgentRow[];
    for (const a of agents) {
      ctx.hub.dropAgentSockets(a.id);
      ctx.presence.offline(a.id);
    }
    db.prepare('DELETE FROM devices WHERE id = ?').run(device.id); // agents 由 ON DELETE 置空 device_id
    audit(db, 'user', p.userId, 'device.delete', { device: device.id }, req.ip);
    res.json({ ok: true });
  });

  return router;
}

function parseCandidates(d: DeviceRow): PairCandidate[] {
  try {
    const parsed: unknown = JSON.parse(d.candidates);
    if (Array.isArray(parsed)) return parsed as PairCandidate[];
  } catch {
    /* fallthrough */
  }
  return [];
}

function readGrants(d: DeviceRow): StoredGrant[] | null {
  if (!d.grants_pending) return null;
  return decryptJson<StoredGrant[]>(d.grants_pending);
}
