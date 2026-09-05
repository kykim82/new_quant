// 핵심 기술지표와 호가 품질 계산의 결정적 동작을 검증한다
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Candle } from '../lib/domain';
import {
  atr,
  donchianHigh,
  dmi,
  ema,
  buildChartPoints,
  lastConfirmedPivotLow,
  median,
  rsi,
  rvol,
} from '../lib/indicators';
import { calculateExecutionQuality } from '../lib/upbit';

function candle(index: number, values: Partial<Candle> = {}): Candle {
  const close = values.close ?? 100;
  return {
    market: 'KRW-TEST',
    unit: 15,
    openTime: index * 900_000,
    closeTime: (index + 1) * 900_000,
    open: values.open ?? close,
    high: values.high ?? close + 1,
    low: values.low ?? close - 1,
    close,
    baseVolume: values.baseVolume ?? 10,
    quoteVolume: values.quoteVolume ?? 100,
    synthetic: values.synthetic ?? false,
  };
}

test('median은 입력을 변경하지 않고 홀수·짝수 중앙값을 계산한다', () => {
  const values = [9, 1, 5, 3];
  assert.equal(median(values), 4);
  assert.deepEqual(values, [9, 1, 5, 3]);
  assert.equal(median([7, 2, 4]), 4);
  assert.equal(median([]), null);
});

test('EMA는 SMA 시드 이후 지수 이동평균을 계산한다', () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5, 6], 3), [null, null, 2, 3, 4, 5]);
});

test('RSI는 일방 상승에서 100, 무변동에서 50이다', () => {
  assert.equal(rsi([1, 2, 3, 4, 5], 3).at(-1), 100);
  assert.equal(rsi([2, 2, 2, 2, 2], 3).at(-1), 50);
});

test('ATR은 갭을 포함한 Wilder 평균을 사용한다', () => {
  const candles = [
    candle(0, { high: 11, low: 9, close: 10 }),
    candle(1, { high: 13, low: 10, close: 12 }),
    candle(2, { high: 14, low: 11, close: 13 }),
  ];
  assert.equal(atr(candles, 2)[1], 2.5);
  assert.equal(atr(candles, 2)[2], 2.75);
});

test('RVOL과 Donchian 기준선은 현재 봉을 기준 구간에서 제외한다', () => {
  const candles = Array.from({ length: 21 }, (_, index) => candle(index, {
    high: 100 + index,
    quoteVolume: index === 20 ? 250 : 100,
  }));
  assert.equal(rvol(candles, 20)[20], 2.5);
  assert.equal(donchianHigh(candles, 20)[20], 119);
});

test('피벗 저점은 오른쪽 확인 봉이 있는 마지막 지점만 반환한다', () => {
  const lows = [8, 7, 5, 7, 8, 6, 4, 6, 7];
  const candles = lows.map((low, index) => candle(index, { low, high: low + 3, close: low + 1 }));
  assert.deepEqual(lastConfirmedPivotLow(candles, 2, 2), { index: 6, price: 4 });
});

test('DMI는 정확히 2배 기간의 입력에서 첫 ADX를 계산한다', () => {
  const candles = Array.from({ length: 28 }, (_, index) => candle(index, {
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
  }));
  assert.notEqual(dmi(candles, 14).adx.at(-1), null);
});

test('잘못된 기간과 0개 차트 요청은 안전한 빈 결과를 반환한다', () => {
  const candles = [candle(0), candle(1)];
  assert.deepEqual(rvol(candles, 0), [null, null]);
  assert.deepEqual(donchianHigh(candles, -1), [null, null]);
  assert.equal(lastConfirmedPivotLow(candles, 0, 1), null);
  assert.deepEqual(buildChartPoints(candles, 0), []);
});

test('호가 품질은 스프레드와 100만원 매수 슬리피지를 계산한다', () => {
  const quality = calculateExecutionQuality({
    market: 'KRW-TEST',
    timestamp: 1_000,
    levels: [
      { askPrice: 101, bidPrice: 99, askSize: 5_000, bidSize: 5_000 },
      { askPrice: 102, bidPrice: 98, askSize: 5_000, bidSize: 5_000 },
    ],
  }, 1_000_000, 1, 1_500);

  assert.equal(quality.spreadPct, 2);
  assert.equal(quality.sufficientDepth, true);
  assert.ok(quality.buySlippagePct > 0);
  assert.equal(quality.tickSize, 1);
  assert.equal(quality.tickSizeReferencePrice, 101);
});
