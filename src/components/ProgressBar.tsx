'use client';

export function ProgressBar({
  value,
  label,
}: {
  /** 0–100 */
  value: number;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const active = pct > 0 && pct < 100;
  return (
    <div>
      {label && (
        <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-slate-600">{label}</span>
          <span className="tnum text-sm font-bold text-slate-900">{pct}%</span>
        </div>
      )}
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200/80"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`relative h-full rounded-full bg-gradient-to-r from-brand-500 via-brand-600 to-violet-500 transition-all duration-500 ease-out ${active ? 'after:absolute after:inset-0 after:animate-shimmer after:bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.45)_50%,transparent_70%)] after:bg-[length:200%_100%]' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
