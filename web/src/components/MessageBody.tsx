import { Fragment, type ReactNode } from 'react';

/**
 * 安全的轻量消息渲染：纯 React 节点，绝不使用 innerHTML。
 * 支持：@提及高亮、`行内代码`、**加粗**、链接。
 */
export function MessageBody({ text }: { text: string }) {
  return <>{render(text)}</>;
}

function render(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 先按提及切分
  const mentionRe = /(?<![A-Za-z0-9_@.])@([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]{0,47})(?=$|[^\w\u4e00-\u9fa5-])/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = mentionRe.exec(text)) !== null) {
    out.push(<Fragment key={key++}>{inline(text.slice(last, m.index), key++)}</Fragment>);
    out.push(
      <span className="mention" key={key++}>
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(<Fragment key={key++}>{inline(text.slice(last), key++)}</Fragment>);
  return out;
}

function inline(text: string, baseKey: number): ReactNode[] {
  // `code` 与 **bold**
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = baseKey * 1000;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      out.push(
        <code key={k++} className="mono" style={{ background: 'var(--surface-3)', padding: '1px 6px', borderRadius: 6, fontSize: '0.92em' }}>
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(<strong key={k++}>{m[2].slice(2, -2)}</strong>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
