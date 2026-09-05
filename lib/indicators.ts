// 완료된 캔들에서 재현 가능한 기술지표를 계산하는 순수 함수를 제공한다
import type { Candle, ChartPoint } from '@/lib/domain';

export type NullableSeries = Array<number | null>;

function finite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0 || !finite(values)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function ema(values: readonly number[], period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (period <= 0 || values.length < period || !finite(values)) return result;

  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = seed;
  const alpha = 2 / (period + 1);
  let previous = seed;

  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * alpha + previous * (1 - alpha);
    result[index] = previous;
  }
  return result;
}

export function rsi(values: readonly number[], period = 14): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (period <= 0 || values.length <= period || !finite(values)) return result;

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gainSum += Math.max(change, 0);
    lossSum += Math.max(-change, 0);
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  const valueFromAverages = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    const strength = averageGain / averageLoss;
    return 100 - 100 / (1 + strength);
  };

  result[period] = valueFromAverages();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = valueFromAverages();
  }
  return result;
}

export function trueRanges(candles: readonly Candle[]): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

export function atr(candles: readonly Candle[], period = 14): NullableSeries {
  const ranges = trueRanges(candles);
  const result: NullableSeries = Array(candles.length).fill(null);
  if (period <= 0 || ranges.length < period || !finite(ranges)) return result;

  let average = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < ranges.length; index += 1) {
    average = (average * (period - 1) + ranges[index]) / period;
    result[index] = average;
  }
  return result;
}

export interface DmiResult {
  adx: NullableSeries;
  plusDi: NullableSeries;
  minusDi: NullableSeries;
}

export function dmi(candles: readonly Candle[], period = 14): DmiResult {
  const adx: NullableSeries = Array(candles.length).fill(null);
  const plusDi: NullableSeries = Array(candles.length).fill(null);
  const minusDi: NullableSeries = Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period * 2) return { adx, plusDi, minusDi };

  const ranges = trueRanges(candles);
  const plusDm = candles.map((candle, index) => {
    if (index === 0) return 0;
    const up = candle.high - candles[index - 1].high;
    const down = candles[index - 1].low - candle.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = candles.map((candle, index) => {
    if (index === 0) return 0;
    const up = candle.high - candles[index - 1].high;
    const down = candles[index - 1].low - candle.low;
    return down > up && down > 0 ? down : 0;
  });

  let smoothedTr = ranges.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedPlus = plusDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedMinus = minusDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  const dxValues: number[] = [];
  let previousAdx: number | null = null;

  for (let index = period; index < candles.length; index += 1) {
    if (index > period) {
      smoothedTr = smoothedTr - smoothedTr / period + ranges[index];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm[index];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm[index];
    }

    if (smoothedTr <= 0) {
      plusDi[index] = 0;
      minusDi[index] = 0;
      dxValues.push(0);
    } else {
      const plus = (100 * smoothedPlus) / smoothedTr;
      const minus = (100 * smoothedMinus) / smoothedTr;
      plusDi[index] = plus;
      minusDi[index] = minus;
      dxValues.push(plus + minus === 0 ? 0 : (100 * Math.abs(plus - minus)) / (plus + minus));
    }

    if (dxValues.length === period) {
      previousAdx = dxValues.reduce((sum, value) => sum + value, 0) / period;
      adx[index] = previousAdx;
    } else if (dxValues.length > period && previousAdx !== null) {
      previousAdx = (previousAdx * (period - 1) + dxValues.at(-1)!) / period;
      adx[index] = previousAdx;
    }
  }
  return { adx, plusDi, minusDi };
}

export interface PpoResult {
  ppo: NullableSeries;
  signal: NullableSeries;
  histogram: NullableSeries;
}

export function ppo(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): PpoResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const ppoSeries: NullableSeries = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return fastValue === null || slowValue === null || slowValue === 0
      ? null
      : ((fastValue - slowValue) / slowValue) * 100;
  });
  const firstValid = ppoSeries.findIndex((value) => value !== null);
  const signal: NullableSeries = Array(values.length).fill(null);
  if (firstValid >= 0) {
    const compact = ppoSeries.slice(firstValid) as number[];
    const compactSignal = ema(compact, signalPeriod);
    compactSignal.forEach((value, index) => { signal[firstValid + index] = value; });
  }
  const histogram = ppoSeries.map((value, index) =>
    value === null || signal[index] === null ? null : value - signal[index]!,
  );
  return { ppo: ppoSeries, signal, histogram };
}

export function cmf(candles: readonly Candle[], period = 20): NullableSeries {
  const result: NullableSeries = Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period) return result;
  const flows = candles.map((candle) => {
    const range = candle.high - candle.low;
    const multiplier = range === 0 ? 0 : ((candle.close - candle.low) - (candle.high - candle.close)) / range;
    return multiplier * candle.baseVolume;
  });

  for (let index = period - 1; index < candles.length; index += 1) {
    const start = index - period + 1;
    const volume = candles.slice(start, index + 1).reduce((sum, candle) => sum + candle.baseVolume, 0);
    const flow = flows.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
    result[index] = volume === 0 ? null : flow / volume;
  }
  return result;
}

export function rvol(candles: readonly Candle[], period = 20): NullableSeries {
  const result: NullableSeries = Array(candles.length).fill(null);
  if (period <= 0) return result;
  for (let index = period; index < candles.length; index += 1) {
    const baseline = median(candles.slice(index - period, index).map((candle) => candle.quoteVolume));
    result[index] = baseline === null || baseline <= 0 ? null : candles[index].quoteVolume / baseline;
  }
  return result;
}

export function donchianHigh(candles: readonly Candle[], period = 20): NullableSeries {
  const result: NullableSeries = Array(candles.length).fill(null);
  if (period <= 0) return result;
  for (let index = period; index < candles.length; index += 1) {
    result[index] = Math.max(...candles.slice(index - period, index).map((candle) => candle.high));
  }
  return result;
}

export function lastConfirmedPivotLow(
  candles: readonly Candle[],
  left = 2,
  right = 2,
): { index: number; price: number } | null {
  if (left < 1 || right < 1 || candles.length < left + right + 1) return null;
  let latest: { index: number; price: number } | null = null;
  for (let index = left; index <= candles.length - right - 1; index += 1) {
    const candidate = candles[index].low;
    const neighbors = candles.slice(index - left, index + right + 1);
    if (neighbors.every((candle, offset) => offset === left || candidate <= candle.low)) {
      latest = { index, price: candidate };
    }
  }
  return latest;
}

export function buildChartPoints(candles: readonly Candle[], limit = 64): ChartPoint[] {
  const visibleLimit = Math.max(0, Math.floor(limit));
  if (visibleLimit === 0) return [];
  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  return candles.slice(-visibleLimit).map((candle, visibleIndex) => {
    const index = candles.length - Math.min(visibleLimit, candles.length) + visibleIndex;
    return {
      time: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      quoteVolume: candle.quoteVolume,
      ema20: ema20[index],
      ema50: ema50[index],
      ema200: ema200[index],
    };
  });
}

export function lastValue(series: readonly (number | null)[]): number | null {
  return series.length === 0 ? null : series[series.length - 1];
}
