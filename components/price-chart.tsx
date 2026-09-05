'use client';
// 추천 가격선과 핵심 이동평균을 함께 그리는 반응형 캔들 차트

import { useMemo } from 'react';

import type { Candidate, CandleUnit, ChartPoint } from '@/lib/domain';
import { krwTickSize } from '@/lib/tick-size';

interface PriceChartProps {
  candidate: Candidate;
  unit: CandleUnit;
}

const WIDTH = 720;
const PRICE_TOP = 18;
const PRICE_BOTTOM = 224;
const VOLUME_TOP = 246;
const VOLUME_BOTTOM = 296;

function priceDigits(price: number): number {
  const tickSize = krwTickSize(price);
  return tickSize >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(tickSize)));
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: priceDigits(price) }).format(price);
}

function pathFor(
  points: readonly ChartPoint[],
  selector: (point: ChartPoint) => number | null,
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let started = false;
  return points.reduce((path, point, index) => {
    const value = selector(point);
    if (value === null) return path;
    const command = started ? 'L' : 'M';
    started = true;
    return `${path}${command}${x(index).toFixed(2)},${y(value).toFixed(2)} `;
  }, '');
}

export function PriceChart({ candidate, unit }: PriceChartProps) {
  const points = candidate.charts[String(unit) as '15' | '60' | '240'];
  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const planPrices = [
      candidate.plan.entryLow,
      candidate.plan.entryHigh,
      candidate.plan.stop,
      ...candidate.plan.targets,
    ];
    const low = Math.min(...points.map((point) => point.low), ...planPrices);
    const high = Math.max(...points.map((point) => point.high), ...planPrices);
    const padding = Math.max((high - low) * 0.06, high * 0.0005);
    const minimum = low - padding;
    const maximum = high + padding;
    const maxVolume = Math.max(...points.map((point) => point.quoteVolume), 1);
    const x = (index: number) => 10 + (index / Math.max(points.length - 1, 1)) * (WIDTH - 20);
    const y = (price: number) => PRICE_BOTTOM - ((price - minimum) / (maximum - minimum)) * (PRICE_BOTTOM - PRICE_TOP);
    return { minimum, maximum, maxVolume, x, y };
  }, [candidate.plan, points]);

  if (!geometry || points.length === 0) {
    return <div className="chart-empty">차트 데이터가 없습니다.</div>;
  }

  const candleWidth = Math.max(2.2, Math.min(7, (WIDTH / points.length) * 0.58));
  const lines = [
    { label: '매수', price: candidate.plan.entryAnchor, className: 'level-entry' },
    { label: '손절', price: candidate.plan.stop, className: 'level-stop' },
    ...candidate.plan.targets.map((price, index) => ({ label: `${index + 1}차`, price, className: 'level-target' })),
  ];

  return (
    <div className="market-chart">
      <div className="chart-legend" aria-hidden="true">
        <span><i className="ema20" />EMA 20</span>
        <span><i className="ema50" />EMA 50</span>
        {unit === 240 && <span><i className="ema200" />EMA 200</span>}
      </div>
      <svg
        aria-label={`${candidate.koreanName} ${unit}분봉 차트. 매수가 ${formatPrice(candidate.plan.entryAnchor)}원, 손절가 ${formatPrice(candidate.plan.stop)}원.`}
        viewBox={`0 0 ${WIDTH} 310`}
      >
        <title>{candidate.koreanName} {unit}분봉과 추천 가격선</title>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = PRICE_TOP + ratio * (PRICE_BOTTOM - PRICE_TOP);
          return <line className="grid-line" key={ratio} x1="0" x2={WIDTH} y1={y} y2={y} />;
        })}
        {points.map((point, index) => {
          const x = geometry.x(index);
          const rising = point.close >= point.open;
          const bodyTop = geometry.y(Math.max(point.open, point.close));
          const bodyBottom = geometry.y(Math.min(point.open, point.close));
          const volumeHeight = (point.quoteVolume / geometry.maxVolume) * (VOLUME_BOTTOM - VOLUME_TOP);
          return (
            <g className={rising ? 'candle-rise' : 'candle-fall'} key={point.time}>
              <line x1={x} x2={x} y1={geometry.y(point.high)} y2={geometry.y(point.low)} />
              <rect height={Math.max(1.5, bodyBottom - bodyTop)} width={candleWidth} x={x - candleWidth / 2} y={bodyTop} />
              <rect className="volume-bar" height={volumeHeight} width={candleWidth} x={x - candleWidth / 2} y={VOLUME_BOTTOM - volumeHeight} />
            </g>
          );
        })}
        <path className="ema-line ema20-path" d={pathFor(points, (point) => point.ema20, geometry.x, geometry.y)} />
        <path className="ema-line ema50-path" d={pathFor(points, (point) => point.ema50, geometry.x, geometry.y)} />
        {unit === 240 && <path className="ema-line ema200-path" d={pathFor(points, (point) => point.ema200, geometry.x, geometry.y)} />}
        {lines.map((line) => {
          const y = geometry.y(line.price);
          return (
            <g className={line.className} key={line.label}>
              <line x1="0" x2={WIDTH} y1={y} y2={y} />
              <text x={WIDTH - 8} y={Math.max(PRICE_TOP + 10, Math.min(PRICE_BOTTOM - 3, y - 4))}>{line.label} {formatPrice(line.price)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
