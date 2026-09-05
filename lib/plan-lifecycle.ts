// 고정 가격 계획의 손절·목표 도달 이력을 보존하고 신규 진입 상태와 분리한다.
import type { Candle, Candidate, SavedPlan } from './domain';

export function createSavedPlan(candidate: Candidate): SavedPlan {
  return { candidate, checkedThrough: candidate.signalTime };
}

export function advanceSavedPlan(original: SavedPlan, candles: readonly Candle[], price: number, now: number): SavedPlan {
  const result = { ...original };
  const plan = original.candidate.plan;
  const bars = candles.filter(c => c.openTime >= original.candidate.signalTime && c.closeTime > original.checkedThrough && c.closeTime <= now);
  for (const bar of bars) {
    if (bar.openTime > result.checkedThrough || bar.synthetic) result.hasGap = true;
    if (!bar.synthetic) {
      if (bar.low < plan.stop) result.stoppedAt ??= bar.closeTime;
      if (bar.high >= plan.targets[0]) result.targetReachedAt ??= bar.closeTime;
    }
    result.checkedThrough = bar.closeTime;
  }
  if (price < plan.stop) result.stoppedAt ??= now;
  if (price >= plan.targets[0]) result.targetReachedAt ??= now;
  return result;
}

export function planBlockReason(plan: SavedPlan): string | undefined {
  if (plan.stoppedAt !== undefined) return '손절가 하회 확인 · 계획 종료';
  if (plan.hasGap) return '관측 이력 공백 · 신규 진입 대기';
  if (plan.targetReachedAt !== undefined) return '1차 목표 도달 이력 · 신규 진입 대기';
  return undefined;
}

export function canReplacePlan(previous: SavedPlan | undefined, candidate: Candidate): boolean {
  return !previous || (previous.stoppedAt !== undefined && candidate.signalTime > previous.stoppedAt);
}

export function describeSavedPlan(saved: SavedPlan, candidate: Candidate | undefined, reason: string, now: number, validFor: number): SavedPlan {
  const block = planBlockReason(saved);
  const ready = Boolean(candidate) && !block;
  const snapshot = candidate ?? saved.candidate;
  return { ...saved, candidate: { ...snapshot, setup: saved.candidate.setup, signalTime: saved.candidate.signalTime,
    plan: saved.candidate.plan, entryStatus: saved.stoppedAt !== undefined ? 'stopped' : ready ? 'ready' : 'waiting',
    entryBlockReason: block ?? (ready ? undefined : reason), entryValidUntil: ready ? now + validFor : 0 } };
}
