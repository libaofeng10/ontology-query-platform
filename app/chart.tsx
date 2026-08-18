"use client";

import type { QueryAnswer } from "./types";

export function DataChart({ answer }: { answer: QueryAnswer }) {
  const { rows, chart } = answer;
  if (!chart) return null;
  const values = rows.map((row) => Number(row[chart.yKey]));
  const max = Math.max(...values, 1);

  if (chart.type === "bar") {
    return (
      <div className="bar-chart" role="img" aria-label={`${answer.question}柱状图`}>
        {rows.map((row, index) => (
          <div className="bar-item" key={String(row[chart.xKey])}>
            <span className="bar-value">{formatCompact(values[index])}{chart.yKey === "rate" ? "%" : ""}</span>
            <div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(8, values[index] / max * 100)}%` }} /></div>
            <span className="bar-label">{String(row[chart.xKey])}</span>
          </div>
        ))}
      </div>
    );
  }

  const width = 640;
  const height = 220;
  const points = values.map((value, index) => {
    const x = 34 + (index * (width - 68)) / Math.max(rows.length - 1, 1);
    const y = height - 32 - (value / max) * (height - 72);
    return { x, y, value, label: String(rows[index][chart.xKey]) };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `34,${height - 32} ${line} ${width - 34},${height - 32}`;

  return (
    <div className="line-chart" role="img" aria-label={`${answer.question}趋势图`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75, 1].map((ratio) => <line key={ratio} x1="34" x2={width - 34} y1={height - 32 - ratio * (height - 72)} y2={height - 32 - ratio * (height - 72)} className="grid-line" />)}
        <defs>
          <linearGradient id="areaGlow" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#5eead4" stopOpacity=".28" />
            <stop offset="100%" stopColor="#5eead4" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#areaGlow)" />
        <polyline points={line} className="trend-line" />
        {points.map((point) => <circle key={point.label} cx={point.x} cy={point.y} r="4.5" className="trend-dot" />)}
      </svg>
      <div className="axis-labels">{points.map((point) => <span key={point.label}>{point.label}</span>)}</div>
    </div>
  );
}

export function formatCompact(value: number) {
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 1 : 2)}万`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}
