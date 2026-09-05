// 모의 성과에서 미진입·봉 내 순서 불명확·비용·분할 청산을 검증한다
import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePaper, type PaperTrade } from '../lib/paper-trades';
import type { Candle } from '../lib/domain';
const original: PaperTrade = { id: 'x', variant: 'improved', market: 'KRW-X', status: 'pending', createdAt: 0, lastClose: 0,
  entryExpires: 1_800_000, holdUntil: 20_000_000, entry: 100, stop: 98, targets: [102, 104, 106], sold: 0, netPct: 0, costRate: 0.001 };
function bar(index: number, low: number, high: number): Candle {
  return { market: 'KRW-X', unit: 15, openTime: index * 900_000, closeTime: (index + 1) * 900_000,
    open: 101, close: 101, high, low, baseVolume: 1, quoteVolume: 100, synthetic: false };
}
test('매수가에 닿지 않고 목표만 도달하면 수익으로 기록하지 않는다', () => {
  const result = advancePaper(original, [bar(0, 101, 108), bar(1, 101, 110)], 1_800_000);
  assert.equal(result.status, 'expired'); assert.equal(result.netPct, 0);
});
test('매수 봉에서 목표 또는 손절에 같이 닿으면 불명확으로 기록한다', () => {
  assert.equal(advancePaper(original, [bar(0, 99, 103)], 900_000).status, 'ambiguous');
});
test('체결 이후 세 목표를 1/3씩 청산하고 비용을 반영한다', () => {
  const result = advancePaper(original, [bar(0, 99, 101), bar(1, 100, 103), bar(2, 101, 105), bar(3, 103, 107)], 3_600_000);
  assert.equal(result.status, 'closed'); assert.equal(result.sold, 3);
  assert.ok(result.netPct < 4 && result.netPct > 3.7);
});
test('보유 중 목표·손절 동시 도달은 임의로 승리 처리하지 않는다', () => {
  const result = advancePaper(original, [bar(0, 99, 101), bar(1, 97, 108)], 1_800_000);
  assert.equal(result.status, 'ambiguous');
});
test('평가 구간 누락을 확인하면 결과 추정 대신 누락으로 분류한다', () => {
  assert.equal(advancePaper(original, [bar(4, 99, 108)], 5_000_000).status, 'data_gap');
});

test('목표가 하나면 1/3만 청산하고 잔량은 보유 만료 가격으로 처리한다', () => {
  const partial = { ...original, variant: 'confluence-v3' as const, targets: [102], holdUntil: 2_700_000 };
  const open = advancePaper(partial, [bar(0, 99, 101), bar(1, 100, 103)], 1_800_000);
  assert.equal(open.status, 'open'); assert.equal(open.sold, 1);
  const closed = advancePaper(open, [bar(2, 100, 101)], 2_700_000);
  assert.equal(closed.status, 'closed'); assert.equal(closed.sold, 1);
  assert.ok(closed.netPct > open.netPct);
});
