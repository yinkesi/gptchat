/** 带 HTTP 状态码的业务错误；错误信息面向用户，绝不携带内部细节。 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'BAD_REQUEST', msg);
export const unauthorized = (msg = '未登录或凭据无效') => new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = '没有权限执行此操作') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = '资源不存在') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new HttpError(409, 'CONFLICT', msg);
export const gone = (msg = '资源已过期') => new HttpError(410, 'GONE', msg);
export const tooMany = (msg = '请求过于频繁，请稍后再试', headers?: Record<string, string>) =>
  new HttpError(429, 'RATE_LIMITED', msg, headers);
