// 고정 계획의 장기 보존·손절 이력·목표 선도달·재발행 경계와 비용 누락을 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle, Candidate } from '../lib/domain';
import { advanceSavedPlan, canReplacePlan, createSavedPlan, describeSavedPlan, planBlockReason } from '../lib/plan-lifecycle';
import { costedPlan } from '../lib/confluence-plan';
import { newPaper } from '../lib/paper-trades';

const candidate: Candidate = { market: 'KRW-X', koreanName: '테스트', englishName: 'Test', strategy: 'scalp', setup: 'breakout',
  score: 80, rank: 0, currentPrice: 100, signedChangeRate: 0, quoteVolume24h: 1e10, signalTime: 0, reasons: [], warnings: [],
  metrics: { rsi: 55, atrPct: 1, rvol: 2, spreadPct: 0.01, slippagePct: 0.01 }, charts: { '15': [], '60': [], '240': [] },
  plan: { entryLow: 99, entryHigh: 101, entryAnchor: 100, stop: 95, targets: [105, 110, 120], riskPct: 5, netRewardRiskAtTarget2: 2,
    expiresAt: 900_000, version: 'confluence-v3', id: 'fixed-test', issuedAt: 0 } };
const bar = (index: number, low = 99, high = 102): Candle => ({ market: 'KRW-X', unit: 15, openTime: index * 900_000,
  closeTime: (index + 1) * 900_000, open: 100, close: 100, low, high, synthetic: false, quoteVolume: 100, baseVolume: 1 });

test('시간 만료·진입 형태 변경·새 목표 계산에도 최초 가격과 ID를 유지한다', () => {
  const initial = createSavedPlan(candidate);
  const next = { ...candidate, setup: 'pullback' as const, signalTime: 9_000_000, plan: { ...candidate.plan, entryAnchor: 102, stop: 96, targets: [106, 115, 125], id: 'new' } };
  assert.equal(canReplacePlan(initial, next), false);
  const refreshed = describeSavedPlan(initial, next, '', 9_000_000, 1_200_000);
  assert.deepEqual(refreshed.candidate.plan, candidate.plan);
  assert.equal(refreshed.candidate.setup, 'breakout');
  assert.equal(refreshed.candidate.entryStatus, 'ready');
});

test('현재가가 복귀해도 중간 완료 봉의 손절 하회 이력을 보존한다', () => {
  const stopped = advanceSavedPlan(createSavedPlan(candidate), [bar(0, 94)], 100, 900_000);
  assert.equal(stopped.stoppedAt, 900_000);
  assert.match(planBlockReason(stopped)!, /계획 종료/);
  const recovered = advanceSavedPlan(stopped, [bar(1)], 100, 1_800_000);
  assert.equal(recovered.stoppedAt, stopped.stoppedAt);
  assert.deepEqual(recovered.candidate.plan, candidate.plan);
});

test('손절 하회 이후 신호만 새 계획으로 교체 가능하며 같은 봉 재발행은 금지한다', () => {
  const stopped = advanceSavedPlan(createSavedPlan(candidate), [bar(0, 94)], 100, 900_000);
  assert.equal(canReplacePlan(stopped, { ...candidate, signalTime: 900_000 }), false);
  assert.equal(canReplacePlan(stopped, { ...candidate, signalTime: 1_800_000 }), true);
});

test('손절과 동일 가격은 하회가 아니며 관측 현재가가 아래면 즉시 종료한다', () => {
  assert.equal(advanceSavedPlan(createSavedPlan(candidate), [bar(0, 95)], 95, 900_000).stoppedAt, undefined);
  assert.equal(advanceSavedPlan(createSavedPlan(candidate), [], 94.9, 1000).stoppedAt, 1000);
});

test('목표 도달 이후 되돌림에도 신규 진입 대기를 유지하고 가격은 삭제하지 않는다', () => {
  const reached = advanceSavedPlan(createSavedPlan(candidate), [bar(0, 99, 106)], 100, 900_000);
  const returned = advanceSavedPlan(reached, [bar(1)], 100, 1_800_000);
  const described = describeSavedPlan(returned, candidate, '', 1_800_000, 1_200_000);
  assert.equal(described.candidate.entryStatus, 'waiting');
  assert.match(described.candidate.entryBlockReason!, /목표 도달/);
  assert.equal(canReplacePlan(returned, candidate), false);
  assert.deepEqual(described.candidate.plan, candidate.plan);
});

test('추세 약화로 대기하다 조건이 회복되면 동일 계획으로만 진입을 재개한다', () => {
  const waiting = describeSavedPlan(createSavedPlan(candidate), undefined, '추세 약화', 1000, 1_200_000);
  const resumed = describeSavedPlan(waiting, candidate, '', 900_000, 1_200_000);
  assert.equal(waiting.candidate.entryStatus, 'waiting'); assert.equal(resumed.candidate.entryStatus, 'ready');
  assert.deepEqual(resumed.candidate.plan, waiting.candidate.plan);
});

test('관측 공백은 정상으로 추정하지 않고 대기로 고정하며 미완성 봉은 읽지 않는다', () => {
  const gap = advanceSavedPlan(createSavedPlan(candidate), [bar(2)], 100, 2_700_000);
  assert.equal(gap.hasGap, true);
  assert.match(planBlockReason(gap)!, /공백/);
  const synthetic = advanceSavedPlan(createSavedPlan(candidate), [{ ...bar(0), synthetic: true }], 100, 900_000);
  assert.equal(synthetic.hasGap, true);
  const unfinished = advanceSavedPlan(createSavedPlan(candidate), [bar(0, 90)], 100, 800_000);
  assert.equal(unfinished.stoppedAt, undefined);
});

test('현재가만 갱신해도 목표·손절 이력을 JSON 저장 후 재개할 수 있다', () => {
  const reached = advanceSavedPlan(createSavedPlan(candidate), [], 106, 1000);
  const restored = JSON.parse(JSON.stringify(reached));
  assert.equal(advanceSavedPlan(restored, [], 100, 2000).targetReachedAt, 1000);
});

test('호가 비용이 없으면 NaN 목표나 순수익을 내보내지 않는다', () => {
  const plan = costedPlan(candidate.plan, 0.0005, Infinity);
  assert.deepEqual(plan.targets, candidate.plan.targets);
  assert.equal(plan.netReturns, undefined); assert.equal(plan.netSplitReturn, null);
});

test('새 고정 계획 모의 진입 유효 시간은 과거 가격 계획 만료와 분리한다', () => {
  const ready = describeSavedPlan(createSavedPlan(candidate), candidate, '', 9_000_000, 1_200_000).candidate;
  const paper = newPaper(ready, 'fixed-plan-v4', 9_000_000);
  assert.equal(paper.entryExpires, 10_200_000);
  assert.deepEqual(paper.targets, candidate.plan.targets);
});
