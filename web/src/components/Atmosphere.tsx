import { useEffect, useRef } from 'react';

/** 背景氛围：极光渐变 + 尘埃粒子画布 + 暗角。 */
export function Atmosphere({ dust = true }: { dust?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!dust) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.classList.add('is-live');

    let raf = 0;
    let w = 0;
    let h = 0;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const COLORS = ['91,157,255', '180,138,224', '232,127,137', '233,235,243'];
    interface P {
      x: number; y: number; r: number; vx: number; vy: number; c: string; tw: number;
    }
    let parts: P[] = [];

    const resize = (): void => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * DPR;
      canvas.height = h * DPR;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const n = Math.min(110, Math.floor((w * h) / 18000));
      parts = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.8,
        vx: (Math.random() - 0.5) * 0.12,
        vy: -0.04 - Math.random() * 0.12,
        c: COLORS[Math.floor(Math.random() * COLORS.length)]!,
        tw: Math.random() * Math.PI * 2,
      }));
    };
    resize();
    window.addEventListener('resize', resize);

    const tick = (): void => {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.tw += 0.02;
        if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
        if (p.x < -8) p.x = w + 8;
        if (p.x > w + 8) p.x = -8;
        const alpha = 0.14 + 0.22 * (0.5 + 0.5 * Math.sin(p.tw));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.c},${alpha.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [dust]);

  return (
    <>
      <div className="aurora" aria-hidden />
      {dust && <canvas className="dustfield" ref={ref} aria-hidden />}
      <div className="vignette" aria-hidden />
    </>
  );
}
