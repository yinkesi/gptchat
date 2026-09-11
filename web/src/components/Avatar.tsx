const GRADS = [
  'linear-gradient(135deg,#5b9dff,#b48ae0)',
  'linear-gradient(135deg,#b48ae0,#e87f89)',
  'linear-gradient(135deg,#7fd6a4,#5b9dff)',
  'linear-gradient(135deg,#eec27f,#e87f89)',
  'linear-gradient(135deg,#5b9dff,#7fd6a4)',
  'linear-gradient(135deg,#e87f89,#eec27f)',
];

function hashOf(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function Avatar({
  name,
  size = '',
  online,
}: {
  name: string;
  size?: '' | 'lg';
  online?: boolean;
}) {
  const grad = GRADS[hashOf(name) % GRADS.length]!;
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span className={`avatar ${size}`} style={{ background: grad }} title={name}>
      {initial}
      {online !== undefined && <span className={`status-dot ${online ? 'online' : ''}`} />}
    </span>
  );
}
