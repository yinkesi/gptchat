import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { attachPrincipal } from './middleware/auth.js';
import { apiLimiter } from './middleware/common.js';
import { HttpError } from './errors.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { roomsRouter } from './routes/rooms.js';
import { agentsRouter } from './routes/agents.js';
import { collabRouter } from './routes/collab.js';
import { devicesRouter } from './routes/devices.js';
import { PROTOCOL_VERSION } from '@gptchat/shared';
import type { ChatContext } from './core/chat.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createApp(ctx: ChatContext): Express {
  const app = express();
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  // ---------- 安全中间件 ----------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // 运行时注入的样式（设计系统）
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", config.publicUrl, ...config.allowedOrigins],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // CORS：同源直接放行；跨源必须命中白名单（PUBLIC_URL + ALLOWED_ORIGINS），绝不通配
  const allowedOrigins = new Set([config.publicUrl, ...config.allowedOrigins]);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // 非浏览器/同源无 Origin
        cb(null, allowedOrigins.has(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    }),
  );
  // 同源防御网：Host 与 Origin 一致的请求视为同源（覆盖 localhost/127.0.0.1/域名解析差异）
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const host = req.headers.host ?? '';
        if (`${o.protocol}//${o.host}` === `${req.protocol}://${host}` || o.host === host) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      } catch {
        /* 忽略非法 Origin */
      }
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  /**
   * CSRF 纵深防御：浏览器会话（Cookie）发起的写请求必须携带自定义头
   * x-gptchat-web（跨站无法伪造）。令牌鉴权（Bearer）的客户端不受影响。
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (MUTATING.has(req.method)) {
      const usingCookie = Boolean((req as unknown as { cookies?: Record<string, string> }).cookies?.gptchat_session);
      if (usingCookie && req.get('x-gptchat-web') !== '1') {
        res.status(403).json({ error: { code: 'CSRF', message: '缺少必要的请求头' } });
        return;
      }
    }
    next();
  });

  app.use(attachPrincipal);

  // ---------- 健康检查与元信息 ----------
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });
  app.get('/api/v1/meta', (_req, res) => {
    res.json({ name: 'gptchat', version: '0.1.0', protocol: PROTOCOL_VERSION });
  });

  // ---------- 业务路由 ----------
  const api = express.Router();
  api.use(apiLimiter);
  api.use(authRouter);
  api.use(usersRouter);
  api.use(roomsRouter(ctx));
  api.use(agentsRouter(ctx));
  api.use(collabRouter(ctx));
  api.use(devicesRouter(ctx));
  app.use('/api/v1', api);

  // ---------- 404（API）----------
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  // ---------- 静态前端（生产同源部署）----------
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: 'index.html', maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
        res.sendFile(path.join(webDist, 'index.html'));
        return;
      }
      next();
    });
  }

  // ---------- 统一错误处理（不泄漏内部细节）----------
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // express.json 的 body 解析错误
    const type = (err as { type?: string })?.type;
    if (type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in (err as object))) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'TOO_LARGE', message: '请求体过大' } });
      return;
    }
    // 未知错误：记录日志，返回通用信息
    console.error(`[error] ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  return app;
}
