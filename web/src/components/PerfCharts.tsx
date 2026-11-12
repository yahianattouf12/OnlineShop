import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { TimelinePoint } from '../api/benchmark';

/*
 * Two small SVG charts for the Performance page, drawn by hand to keep the site free of chart libraries.
 * Color is only for the marks (lines, bars); every number and name stays in the text colors, and each chart
 * has a table with the same numbers next to it.
 */

/** Categorical colors, in a fixed order checked for color-blind separation on white. */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const AXIS_FONT = 11;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round axis steps: 1, 2, 2.5 or 5 times a power of ten. */
function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(Math.round(value * 1000) / 1000);
  if (ticks[ticks.length - 1] < max) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 1000) / 1000);
  return ticks;
}

export const formatMs = (value: number) =>
  `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value).toLocaleString('en-US')} ms`;

const tickLabel = (value: number) => (value >= 1000 ? `${(value / 1000).toLocaleString('en-US')}k` : value.toLocaleString('en-US'));

export function LegendKey({ color, children, shape = 'line' }: { color: string; children: ReactNode; shape?: 'line' | 'square' }) {
  return (
    <span className="chart-key">
      <span className={shape === 'line' ? 'chart-key-line' : 'chart-key-square'} style={{ background: color }} />
      {children}
    </span>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // Kept inside the chart: flips to the left of the pointer near the right edge.
  const flip = x > width - 190;
  return (
    <div className="chart-tooltip" style={{ top: y, left: flip ? undefined : x + 12, right: flip ? width - x + 12 : undefined }}>
      {children}
    </div>
  );
}

/* ---------- Latency per second (live while a run is going) ---------- */

export function LatencyChart({ points, seconds, height = 220 }: { points: TimelinePoint[]; seconds?: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const margin = { top: 24, right: 16, bottom: 28, left: 52 };
  const plotWidth = Math.max(0, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;
  const lastSecond = points.length ? points[points.length - 1].second : 0;
  const span = Math.max(seconds ?? 0, lastSecond + 1, 5);
  const ticks = niceTicks(Math.max(...points.map((p) => p.p95), 1) * 1.1);
  const top = ticks[ticks.length - 1];
  const x = (second: number) => margin.left + (second / span) * plotWidth;
  const y = (ms: number) => margin.top + plotHeight - (ms / top) * plotHeight;
  const path = (key: 'p50' | 'p95') => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.second).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const xTicks = niceTicks(span, Math.max(2, Math.min(6, Math.floor(plotWidth / 90))));
  const active = hover === null ? null : points[hover];
  const last = points[points.length - 1];

  const onMove = (event: PointerEvent<SVGRectElement>) => {
    if (!points.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    const second = ((event.clientX - box.left) / box.width) * span;
    let nearest = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.second - second) < Math.abs(points[nearest].second - second)) nearest = i;
    });
    setHover(nearest);
  };

  return (
    <div className="chart" ref={ref}>
      <div className="chart-legend">
        <LegendKey color={SERIES_COLORS[0]}>p50 (median)</LegendKey>
        <LegendKey color={SERIES_COLORS[1]}>p95</LegendKey>
      </div>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Response time per second: p50 and p95, in milliseconds">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="chart-grid" />
              <text x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="chart-axis" fontSize={AXIS_FONT}>
                {tickLabel(tick)}
              </text>
            </g>
          ))}
          <text x={margin.left - 8} y={10} textAnchor="end" className="chart-axis" fontSize={AXIS_FONT}>
            ms
          </text>
          {xTicks.filter((t) => t <= span).map((tick) => (
            <text key={tick} x={x(tick)} y={height - 8} textAnchor="middle" className="chart-axis" fontSize={AXIS_FONT}>
              {tick}s
            </text>
          ))}
          {points.length > 0 && (
            <>
              <path d={path('p95')} fill="none" stroke={SERIES_COLORS[1]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <path d={path('p50')} fill="none" stroke={SERIES_COLORS[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {!active && (
                <>
                  <circle cx={x(last.second)} cy={y(last.p95)} r={4} fill={SERIES_COLORS[1]} className="chart-dot" />
                  <circle cx={x(last.second)} cy={y(last.p50)} r={4} fill={SERIES_COLORS[0]} className="chart-dot" />
                </>
              )}
            </>
          )}
          {active && (
            <g>
              <line x1={x(active.second)} x2={x(active.second)} y1={margin.top} y2={margin.top + plotHeight} className="chart-crosshair" />
              <circle cx={x(active.second)} cy={y(active.p95)} r={4} fill={SERIES_COLORS[1]} className="chart-dot" />
              <circle cx={x(active.second)} cy={y(active.p50)} r={4} fill={SERIES_COLORS[0]} className="chart-dot" />
            </g>
          )}
          <rect
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {active && (
        <Tooltip x={x(active.second)} y={margin.top + 28} width={width}>
          <div className="strong">Second {active.second}</div>
          <div className="row gap-xs">
            <LegendKey color={SERIES_COLORS[0]}>p50 {formatMs(active.p50)}</LegendKey>
          </div>
          <div className="row gap-xs">
            <LegendKey color={SERIES_COLORS[1]}>p95 {formatMs(active.p95)}</LegendKey>
          </div>
          <div className="chart-tooltip-muted">
            {active.requests} requests · slowest {formatMs(active.max)}
            {active.failed > 0 && ` · ${active.failed} failed`}
          </div>
        </Tooltip>
      )}
      {!points.length && <div className="chart-empty body-sm muted">Waiting for the first responses…</div>}
    </div>
  );
}

/* ---------- p50 / p95 / p99 by label (before and after) ---------- */

export interface CompareSeries {
  label: string;
  color: string;
  values: { p50: number; p95: number; p99: number } | null;
}

const METRICS = ['p50', 'p95', 'p99'] as const;

/** One rounded-top bar, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function CompareChart({ series, height = 220 }: { series: CompareSeries[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ metric: (typeof METRICS)[number]; index: number } | null>(null);
  const shown = series.filter((s) => s.values);

  const margin = { top: 24, right: 8, bottom: 28, left: 52 };
  const plotWidth = Math.max(0, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;
  const ticks = niceTicks(Math.max(...shown.map((s) => s.values!.p99), 1) * 1.08);
  const top = ticks[ticks.length - 1];
  const y = (ms: number) => margin.top + plotHeight - (ms / top) * plotHeight;
  const group = plotWidth / METRICS.length;
  const gap = 2;
  const bar = Math.max(4, Math.min(24, (group * 0.7 - gap * (shown.length - 1)) / Math.max(1, shown.length)));
  const barX = (metricIndex: number, i: number) =>
    margin.left + group * metricIndex + group / 2 - (shown.length * bar + (shown.length - 1) * gap) / 2 + i * (bar + gap);

  const active = hover ? shown[hover.index] : null;

  return (
    <div className="chart" ref={ref}>
      <div className="chart-legend">
        {series.map((s) => (
          <LegendKey key={s.label} color={s.color} shape="square">
            {s.label}
            {!s.values && <span className="muted"> (no result)</span>}
          </LegendKey>
        ))}
      </div>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="p50, p95 and p99 response time by label, in milliseconds">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="chart-grid" />
              <text x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="chart-axis" fontSize={AXIS_FONT}>
                {tickLabel(tick)}
              </text>
            </g>
          ))}
          <text x={margin.left - 8} y={10} textAnchor="end" className="chart-axis" fontSize={AXIS_FONT}>
            ms
          </text>
          {METRICS.map((metric, m) => (
            <g key={metric}>
              <text x={margin.left + group * m + group / 2} y={height - 8} textAnchor="middle" className="chart-axis chart-axis-strong" fontSize={AXIS_FONT + 1}>
                {metric}
              </text>
              {shown.map((s, i) => {
                const value = s.values![metric];
                const h = Math.max(1, margin.top + plotHeight - y(value));
                const isActive = hover?.metric === metric && hover.index === i;
                return (
                  <g key={s.label}>
                    <path
                      d={barPath(barX(m, i), margin.top + plotHeight - h, bar, h)}
                      fill={s.color}
                      opacity={hover && !isActive ? 0.45 : 1}
                    />
                    {/* A taller, wider invisible target than the bar itself, so short bars are easy to hover. */}
                    <rect
                      x={barX(m, i) - gap / 2}
                      y={margin.top}
                      width={bar + gap}
                      height={plotHeight}
                      fill="transparent"
                      onPointerEnter={() => setHover({ metric, index: i })}
                      onPointerLeave={() => setHover(null)}
                    />
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      )}
      {active && hover && (
        <Tooltip x={barX(METRICS.indexOf(hover.metric), hover.index) + bar} y={margin.top + 28} width={width}>
          <LegendKey color={active.color} shape="square">
            <span className="strong">{active.label}</span>
          </LegendKey>
          <div>
            {hover.metric} {formatMs(active.values![hover.metric])}
          </div>
        </Tooltip>
      )}
      {!shown.length && <div className="chart-empty body-sm muted">No results to draw.</div>}
    </div>
  );
}
