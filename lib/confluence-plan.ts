// 확정 가격 구조·기간 피벗·ABC 확장·고정 TT 목표를 병합해 손절과 독립적인 가격 계획을 만든다.
import type { Candle, ExecutionQuality, PricePlan, Strategy } from './domain';
import type { TrendState } from './trend-state';
import { resolvedKrwTickSize } from './tick-size';
import { atr, lastValue } from './indicators';

export interface Level { price: number; source: string; id: string; structural: boolean }
export interface Zone { low: number; high: number; levels: Level[] }
export interface Pivot { price: number; index: number; time: number; confirmedAt: number; kind: 'high' | 'low' }

export function confirmedPivots(candles: readonly Candle[]): Pivot[] {
  const points: Pivot[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const nearby = candles.slice(i - 2, i + 3);
    if (nearby.some(c => c.synthetic)) continue;
    for (const kind of ['high', 'low'] as const) {
      const value = candles[i][kind];
      // 동률 고저는 오른쪽 마지막 지점만 선택하여 같은 평탄 구간을 중복하지 않는다.
      if (nearby.every((c, j) => j === 2 || (kind === 'high' ? (j < 2 ? value >= c.high : value > c.high) : (j < 2 ? value <= c.low : value < c.low)))) {
        points.push({ price: value, index: i, time: candles[i].openTime, confirmedAt: candles[i + 2].closeTime, kind });
      }
    }
  }
  return points;
}

export function previousPeriod(candles: readonly Candle[], now: number, days: 1 | 7): { high: number; low: number; close: number; time: number } | null {
  const width = days * 86_400_000;
  const offset = days === 7 ? 4 * 86_400_000 : 0; // UTC 월요일 시작.
  const end = Math.floor((now - offset) / width) * width + offset;
  const start = end - width;
  const bars = candles.filter(c => c.openTime >= start && c.closeTime <= end);
  if (bars.length !== days * 6 || bars.some((c, i) => c.synthetic || c.openTime !== start + i * 14_400_000 || c.closeTime !== c.openTime + 14_400_000)) return null;
  return { high: Math.max(...bars.map(c => c.high)), low: Math.min(...bars.map(c => c.low)), close: bars.at(-1)!.close, time: end };
}

export function resistanceLevels(candles: Record<'15' | '60' | '240', Candle[]>, strategy: Strategy, now: number, trends: Record<'15' | '60' | '240', TrendState>): Level[] {
  const levels: Level[] = [];
  const units = strategy === 'scalp' ? ['15', '60', '240'] as const : ['60', '240'] as const;
  for (const unit of units) {
    const bars = candles[unit].filter(c => c.closeTime <= now).slice(-120);
    const pivots = confirmedPivots(bars);
    const waveMinimum = (lastValue(atr(bars, 14)) ?? Infinity) * 2;
    for (const p of pivots.filter(p => p.kind === 'high')) {
      levels.push({ price: p.price, source: `${unit}분 확정 고점`, id: `high:${p.time}:${p.price}`, structural: true });
    }
    const alternating: Pivot[] = [];
    for (const p of pivots) {
      const last = alternating.at(-1);
      if (last?.kind === p.kind) {
        if ((p.kind === 'high' && p.price >= last.price) || (p.kind === 'low' && p.price <= last.price)) alternating[alternating.length - 1] = p;
      } else alternating.push(p);
    }
    for (let i = alternating.length - 1; i >= 2; i--) {
      const [a, b, c] = alternating.slice(i - 2, i + 1);
      if (a.kind !== 'low' || b.kind !== 'high' || c.kind !== 'low' || !(a.price < c.price && c.price < b.price)) continue;
      // C 이후 저점 이탈 또는 이미 이전 고점의 두 배 이상 진행한 파동은 재사용하지 않는다.
      const after = bars.slice(c.index + 1);
      if (after.some(bar => bar.low < c.price) || bars.at(-1)!.close > c.price + 2 * (b.price - a.price)) break;
      // 한두 봉의 잡음 구간을 확장 목표로 과대해석하지 않는다.
      if (b.price - a.price < waveMinimum) continue;
      for (const ratio of [1, 1.272, 1.618]) levels.push({ price: c.price + (b.price - a.price) * ratio,
        source: `${unit}분 ABC 확장 ${ratio}`, id: `fib:${a.time}:${b.time}:${c.time}:${ratio}`, structural: false });
      break;
    }
  }
  for (const days of (strategy === 'scalp' ? [1] : [1, 7]) as Array<1 | 7>) {
    const period = previousPeriod(candles['240'], now, days);
    if (!period) continue;
    const name = days === 1 ? '전일' : '전주';
    const p = (period.high + period.low + period.close) / 3;
    levels.push({ price: period.high, source: `${name} 고점`, id: `period-high:${period.time}:${days}`, structural: true });
    [2 * p - period.low, p + period.high - period.low, period.high + 2 * (p - period.low)].forEach((price, i) => {
      levels.push({ price, source: `${name} Traditional R${i + 1}`, id: `period:${period.time}:${days}:${i}`, structural: false });
    });
  }
  const tt = trends[strategy === 'scalp' ? '15' : '60'];
  if (tt.ttDirection === true && tt.signal && now - tt.signal.time <= (strategy === 'scalp' ? 6 : 72) * 3_600_000) {
    tt.signal.targets.forEach((price, i) => levels.push({ price, source: `TT 신호 고정 ${i + 1}차`, id: `tt:${tt.signal!.time}:${i}`, structural: false }));
  }
  return levels;
}

export function mergeLevels(levels: readonly Level[], tolerance: number): Zone[] {
  const unique = [...new Map(levels.filter(l => Number.isFinite(l.price) && l.price > 0).map(l => [l.id, l])).values()]
    .sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  const zones: Zone[] = [];
  for (const level of unique) {
    const last = zones.at(-1);
    if (last && level.price - last.low <= tolerance) { last.high = level.price; last.levels.push(level); }
    else zones.push({ low: level.price, high: level.price, levels: [level] });
  }
  return zones;
}

export function costedPlan(plan: PricePlan, feeRate: number, slippagePct: number): PricePlan {
  if (!Number.isFinite(slippagePct)) return { ...plan, netReturns: undefined, netSplitReturn: null, netRewardRiskAtTarget2: 0 };
  // 청산 비용은 미래 호가 예측이 아니라 매수 시점과 동일 비율이라는 명시적 시나리오 가정이다.
  const cost = feeRate + slippagePct / 100;
  const entry = plan.entryAnchor * (1 + cost);
  const netReturns = plan.targets.map(target => (target * (1 - cost) / entry - 1) * 100);
  const loss = entry - plan.stop * (1 - cost);
  return { ...plan, grossReturns: plan.targets.map(t => (t / plan.entryAnchor - 1) * 100), netReturns,
    netSplitReturn: plan.targets.length === 3 ? netReturns.reduce((a, b) => a + b, 0) / 3 : null,
    netRewardRiskAtTarget2: plan.targets.length > 1 && loss > 0 ? (plan.targets[1] * (1 - cost) - entry) / loss : 0 };
}

export function buildConfluencePlan(args: { entryLow: number; entryAnchor: number; entryHigh: number; rawStop: number;
  atr: number; execution: ExecutionQuality; levels: Level[]; market: string; strategy: Strategy; signalTime: number;
  expiresAt: number; feeRate: number; entryReason: string; stopReason: string }): PricePlan | null {
  const tick = (price: number) => resolvedKrwTickSize(price, args.execution.tickSize, args.execution.tickSizeReferencePrice);
  const round = (price: number, direction: 'up' | 'down' | 'near') => {
    const step = tick(price);
    return Number(((direction === 'up' ? Math.ceil(price / step) : direction === 'down' ? Math.floor(price / step) : Math.round(price / step)) * step).toPrecision(15));
  };
  const entryLow = round(args.entryLow, 'up'), entryHigh = round(args.entryHigh, 'down'), entryAnchor = round(args.entryAnchor, 'near');
  const stop = round(args.rawStop, 'down');
  if (!(stop > 0 && stop < entryLow && entryLow <= entryAnchor && entryAnchor <= entryHigh)) return null;
  const zones = mergeLevels(args.levels.filter(l => l.price > entryHigh), Math.max(2 * tick(entryAnchor), args.atr * 0.15));
  const targets: number[] = [], evidence: NonNullable<PricePlan['targetEvidence']> = [];
  for (const zone of zones) {
    const target = round(zone.low - tick(zone.low), 'down');
    // 가까운 저항이 진입과 사실상 붙어 있으면 먼 목표로 건너뛰지 않는다.
    if (target <= entryHigh) return null;
    if (target <= (targets.at(-1) ?? entryHigh)) continue;
    targets.push(target);
    evidence.push({ low: zone.low, high: zone.high, kind: zone.levels.some(l => l.structural) ? 'resistance' : 'projection',
      reasons: [...new Set(zone.levels.map(l => l.source))] });
    if (targets.length === 3) break;
  }
  if (!targets.length) return null;
  const plan = costedPlan({ entryLow, entryAnchor, entryHigh, stop, targets, riskPct: (entryAnchor - stop) / entryAnchor * 100,
    netRewardRiskAtTarget2: 0, expiresAt: args.expiresAt, version: 'confluence-v3',
    id: `v3:${args.market}:${args.strategy}:${args.signalTime}`, issuedAt: args.signalTime,
    entryReason: args.entryReason, stopReason: args.stopReason, targetEvidence: evidence }, args.feeRate, args.execution.buySlippagePct);
  // 첫 목표가 비용조차 보상하지 못하면 상위 목표를 이유로 추천하지 않는다.
  return plan.netReturns![0] > 0 ? plan : null;
}
