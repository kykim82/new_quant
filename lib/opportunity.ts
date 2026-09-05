// 거래대금 증가와 상위 시간대 가격 구조를 먼저 평가해 상세 분석 범위를 좁힌다.
import type { Candle, MarketTicker } from './domain';
import { confirmedPivots } from './confluence-plan';
import { ema, lastValue } from './indicators';
import { advanceTrends, type TrendState } from './trend-state';

export const TURNOVER_MIN = 1_000_000_000;
export interface LiquidityScreen {
  checkedAt: number;
  candleClose: number;
  increasing: boolean;
  burst: boolean;
  hourlyRatio: number | null;
  average3d: number | null;
}

export function screenLiquidity(hourly: readonly Candle[], now: number): LiquidityScreen {
  const end = Math.floor(now / 3_600_000) * 3_600_000;
  const bars = hourly.filter(c => c.closeTime <= end);
  const contiguous = (count: number) => bars.length >= count && bars.slice(-count).every((c, i) =>
    c.openTime === end - (count - i) * 3_600_000 && c.closeTime === c.openTime + 3_600_000
    && Number.isFinite(c.quoteVolume) && c.quoteVolume >= 0);
  const sum = (start: number, stop?: number) => bars.slice(start, stop).reduce((n, c) => n + c.quoteVolume, 0);
  const days = contiguous(72) ? [sum(-72, -48), sum(-48, -24), sum(-24)] : null;
  const priorHour = contiguous(21) ? sum(-21, -1) / 20 : 0;
  const lastHour = bars.at(-1)?.quoteVolume ?? 0;
  const hourlyRatio = priorHour > 0 ? lastHour / priorHour : null;
  return { checkedAt: now, candleClose: bars.at(-1)?.closeTime ?? 0,
    increasing: !!days && days[0] > 0 && days[1] > days[0] && days[2] > days[1] && days[2] >= days[0] * 1.5,
    // 거래가 거의 없던 시장의 극단적 비율은 급증 근거로 사용하지 않는다.
    burst: hourlyRatio !== null && hourlyRatio >= 2 && lastHour >= 10_000_000,
    hourlyRatio, average3d: contiguous(96) ? sum(-96, -24) / 3 : null };
}

export function liquidityEligible(ticker: MarketTicker, screen: LiquidityScreen | undefined, now: number): boolean {
  if (ticker.quoteVolume24h >= TURNOVER_MIN) return true;
  return !!screen && screen.candleClose === Math.floor(now / 3_600_000) * 3_600_000
    && (screen.increasing || screen.burst);
}

export interface FrameStructure {
  ready: boolean; alive: boolean; early: boolean; score: number; reason: string;
}

export function frameStructure(candles: readonly Candle[], previousTrend?: TrendState): FrameStructure {
  if (candles.length < 60) return { ready: false, alive: false, early: false, score: 0, reason: '추세 이력 준비' };
  const recent = candles.slice(-12);
  if (recent.some((c, i) => c.synthetic || (i > 0 && c.openTime !== recent[i - 1].closeTime))) {
    return { ready: false, alive: false, early: false, score: 0, reason: '최근 누락 봉 확인 필요' };
  }
  const closes = candles.map(c => c.close);
  const ma = ema(closes, 20);
  const e20 = lastValue(ma)!;
  const e50 = lastValue(ema(closes, 50))!;
  const latest = candles.at(-1)!;
  const pivots = confirmedPivots(candles.slice(-60));
  const lows = pivots.filter(p => p.kind === 'low').slice(-2);
  const high = pivots.filter(p => p.kind === 'high').at(-1);
  const heldLow = lows.length > 0 && latest.close > lows.at(-1)!.price
    && !candles.some(c => c.openTime > lows.at(-1)!.time && c.low < lows.at(-1)!.price);
  const higherLow = lows.length === 2 && lows[1].price > lows[0].price && heldLow;
  const slopeUp = e20 > (ma.at(-4) ?? Infinity);
  const st = previousTrend ?? advanceTrends(candles);
  const established = st.stDirection === 1 && slopeUp && latest.close > e20 && (e20 > e50 || higherLow)
    && (lows.length === 0 || heldLow);
  // ST/장기 정배열이 늦더라도 확정 저점 상승 + 확정 고점 회복은 초기 전환으로 인정한다.
  const early = higherLow && !!high && latest.close > high.price && latest.close > e20 && slopeUp;
  const alive = established || early;
  return { ready: true, alive, early: early && !established, score: alive ? (established ? 85 : 70) : higherLow ? 50 : slopeUp ? 30 : 10,
    reason: alive ? (established ? '상승 구조 유지' : '저점 상승·확정 고점 회복') : higherLow ? '저점 상승 · 고점 회복 대기' : '하락 구조 전환 대기' };
}

export function upperStructure(candles: Record<'15' | '60' | '240', Candle[]>, now: number,
  trends?: Record<'15' | '60' | '240', TrendState>) {
  const h1 = frameStructure(candles['60'].filter(c => c.closeTime <= now), trends?.['60']);
  const h4 = frameStructure(candles['240'].filter(c => c.closeTime <= now), trends?.['240']);
  const fresh = ([60, 240] as const).every(unit => candles[String(unit) as '60' | '240'].at(-1)?.closeTime
    === Math.floor(now / (unit * 60_000)) * unit * 60_000);
  return { h1, h4, ready: h1.ready && h4.ready && fresh, alive: h1.alive && h4.alive && fresh,
    early: h1.early || h4.early, score: Math.round((h1.score + h4.score) / 2),
    reason: !fresh ? '상위 시간대 최신 봉 확인 대기' : `4시간 ${h4.reason} · 1시간 ${h1.reason}` };
}

export function dailyContext(candles: readonly Candle[], now: number): 'up' | 'down' | 'unknown' {
  const end = Math.floor(now / 86_400_000) * 86_400_000;
  const groups = new Map<number, Candle[]>();
  for (const c of candles.filter(c => c.closeTime <= end)) {
    const day = Math.floor(c.openTime / 86_400_000) * 86_400_000;
    groups.set(day, [...(groups.get(day) ?? []), c]);
  }
  const complete = [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([day, bars]) =>
    bars.length === 6 && bars.every((c, i) => !c.synthetic && c.openTime === day + i * 14_400_000));
  const last = complete.slice(-23);
  if (last.length < 23 || last.some(([day], i) => day !== end - (23 - i) * 86_400_000)) return 'unknown';
  const closes = last.map(([, bars]) => bars[5].close);
  const ma = ema(closes, 20);
  return closes.at(-1)! > lastValue(ma)! && lastValue(ma)! > ma.at(-3)! ? 'up' : 'down';
}
