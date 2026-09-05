// 원화마켓 호가 구간과 구간 경계 이동 시 반올림 단위를 검증한다
import assert from 'node:assert/strict';
import test from 'node:test';

import { krwTickSize, resolvedKrwTickSize } from '../lib/tick-size';

test('2025년 7월 31일 이후 원화마켓 호가 단위를 가격 구간별로 반환한다', () => {
  assert.equal(krwTickSize(2_000_000), 1_000);
  assert.equal(krwTickSize(700_000), 500);
  assert.equal(krwTickSize(250_000), 100);
  assert.equal(krwTickSize(75_000), 50);
  assert.equal(krwTickSize(7_500), 5);
  assert.equal(krwTickSize(500), 1);
  assert.equal(krwTickSize(0.000005), 0.00000001);
});

test('목표가가 가격 구간을 넘으면 현재 호가 단위 대신 목표 구간 단위를 적용한다', () => {
  assert.equal(resolvedKrwTickSize(100_200, 50, 99_900), 100);
  assert.equal(resolvedKrwTickSize(99_950, 50, 99_900), 50);
});
