// 완성 봉의 Supertrend와 고정 Target Trend 계획을 증분 계산하고 재시작 상태를 보존한다.
// Target Trend adapted from BigBeluga, CC BY-NC-SA 4.0.
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript adaptation, incremental state and long-only signal metadata added.
import type { Candle } from './domain';

export interface TrendPoint { time: number; supertrend: number | null; targetBand: number | null }
export interface TrendState {
  version: 1; lastClose: number; count: number; previousClose: number | null;
  trSeed: number[]; atr10: number | null; atr200: number | null; atrWindow: number[];
  highs: number[]; lows: number[]; stLower: number | null; stUpper: number | null; stDirection: 1 | -1;
  ttUpper: number | null; ttLower: number | null; ttDirection: boolean | null;
  signal: { time: number; entry: number; stop: number; targets: number[]; width: number } | null;
  history: TrendPoint[];
}

export function trendsReady(candles: Record<'15' | '60' | '240', Candle[]>, trends: Record<'15' | '60' | '240', TrendState>): boolean {
  return (['15', '60', '240'] as const).every(unit => trends[unit].ttUpper !== null && candles[unit].filter(c => !c.synthetic).length >= 399);
}

function initial(): TrendState {
  return { version: 1, lastClose: 0, count: 0, previousClose: null, trSeed: [], atr10: null, atr200: null,
    atrWindow: [], highs: [], lows: [], stLower: null, stUpper: null, stDirection: 1,
    ttUpper: null, ttLower: null, ttDirection: null, signal: null, history: [] };
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

export function advanceTrends(candles: readonly Candle[], previous?: TrendState, asOf = Infinity): TrendState {
  const closed = candles.filter(c => c.closeTime <= asOf);
  const pending = closed.filter(c => c.closeTime > (previous?.lastClose ?? 0));
  const contiguous = !previous || !pending.length || pending[0].openTime === previous.lastClose;
  const state = previous?.version === 1 && contiguous ? structuredClone(previous) : initial();
  for (const bar of closed) {
    if (bar.closeTime <= state.lastClose) continue;
    const pc = state.previousClose;
    const tr = pc === null ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
    state.count++;
    if (state.trSeed.length < 200) state.trSeed.push(tr);
    state.atr10 = state.atr10 === null ? (state.count === 10 ? mean(state.trSeed) : null) : (state.atr10 * 9 + tr) / 10;
    state.atr200 = state.atr200 === null ? (state.count === 200 ? mean(state.trSeed) : null) : (state.atr200 * 199 + tr) / 200;
    if (state.atr200 !== null) {
      state.atrWindow.push(state.atr200);
      if (state.atrWindow.length > 200) state.atrWindow.shift();
    }
    state.highs.push(bar.high); state.lows.push(bar.low);
    if (state.highs.length > 10) { state.highs.shift(); state.lows.shift(); }
    if (state.atr10 !== null) {
      const basicLower = (bar.high + bar.low) / 2 - 3 * state.atr10;
      const basicUpper = (bar.high + bar.low) / 2 + 3 * state.atr10;
      const lower1 = state.stLower ?? basicLower;
      const upper1 = state.stUpper ?? basicUpper;
      state.stLower = pc !== null && pc > lower1 ? Math.max(basicLower, lower1) : basicLower;
      state.stUpper = pc !== null && pc < upper1 ? Math.min(basicUpper, upper1) : basicUpper;
      if (state.stDirection === -1 && bar.close > upper1) state.stDirection = 1;
      else if (state.stDirection === 1 && bar.close < lower1) state.stDirection = -1;
    }
    if (state.atrWindow.length === 200) {
      const width = mean(state.atrWindow) * 0.8;
      const upper = mean(state.highs) + width;
      const lower = mean(state.lows) - width;
      const previousDirection = state.ttDirection;
      if (pc !== null && state.ttUpper !== null && pc <= state.ttUpper && bar.close > upper) state.ttDirection = true;
      if (pc !== null && state.ttLower !== null && pc >= state.ttLower && bar.close < lower) state.ttDirection = false;
      if (state.ttDirection === true && previousDirection === false) {
        state.signal = { time: bar.closeTime, entry: bar.close, stop: lower, targets: [5, 10, 15].map(k => bar.close + k * width), width };
      }
      if (state.ttDirection === false) state.signal = null;
      state.ttUpper = upper; state.ttLower = lower;
    }
    state.previousClose = bar.close; state.lastClose = bar.closeTime;
    state.history.push({ time: bar.openTime, supertrend: state.stDirection === 1 ? state.stLower : state.stUpper,
      targetBand: state.ttDirection === true ? state.ttLower : state.ttDirection === false ? state.ttUpper : null });
    if (state.history.length > 64) state.history.shift();
  }
  return state;
}
