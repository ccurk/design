import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bjDate,
  dateLabel,
  dayLabel,
  rangeLabel,
  resolveWhen,
  slotLabel,
  timeOfDayLabel,
} from '../src/time.js';

// 2026-10-26 是周一；北京时间 10:00 = 02:00Z
const MON = new Date('2026-10-26T02:00:00.000Z');

describe('北京时间工具（不依赖宿主机时区）', () => {
  test('UTC 晚上已经是北京的第二天', () => {
    assert.equal(bjDate(new Date('2026-10-30T21:50:00.000Z')), '2026-10-31');
    assert.equal(bjDate(new Date('2026-10-30T15:59:00.000Z')), '2026-10-30');
  });

  test('日期标签：今天 / 明天 / 周X / 上周X / M月D日', () => {
    assert.equal(dateLabel(new Date('2026-10-30T21:50:00.000Z'), MON), '周六 05:50');
    assert.equal(dateLabel(new Date('2026-10-26T12:00:00.000Z'), MON), '今天 20:00');
    assert.equal(dateLabel(new Date('2026-10-27T01:00:00.000Z'), MON), '明天 09:00');
    assert.equal(dayLabel('2026-10-25', MON), '昨天');
    assert.equal(dayLabel('2026-10-23', MON), '上周五');
    assert.equal(dayLabel('2026-11-08', MON), '11月8日');
  });

  test('when 解析：today / tomorrow / weekend / 具体日期', () => {
    assert.deepEqual(resolveWhen('today', MON), { dateFrom: '2026-10-26', dateTo: '2026-10-26' });
    assert.deepEqual(resolveWhen('tomorrow', MON), { dateFrom: '2026-10-27', dateTo: '2026-10-27' });
    assert.deepEqual(resolveWhen('weekend', MON), { dateFrom: '2026-10-31', dateTo: '2026-11-01' });
    // 周六当天：今明两天；周日当天：只有今天
    assert.deepEqual(resolveWhen('weekend', new Date('2026-10-31T02:00:00.000Z')), { dateFrom: '2026-10-31', dateTo: '2026-11-01' });
    assert.deepEqual(resolveWhen('weekend', new Date('2026-11-01T02:00:00.000Z')), { dateFrom: '2026-11-01', dateTo: '2026-11-01' });
    assert.deepEqual(resolveWhen('2026-11-03', MON), { dateFrom: '2026-11-03', dateTo: '2026-11-03' });
    assert.equal(resolveWhen('2026-02-30', MON), null);
    assert.equal(resolveWhen('someday', MON), null);
    assert.equal(rangeLabel('2026-10-31', '2026-11-01', MON), '本周末');
  });

  test('时间段标签', () => {
    assert.equal(slotLabel('morning', '看日出'), '清晨');
    assert.equal(slotLabel('morning', '爬山'), '上午');
    assert.equal(slotLabel('afternoon'), '下午');
    assert.equal(slotLabel('evening'), '晚上');
    assert.equal(slotLabel('allday'), '全天');
    assert.equal(timeOfDayLabel(new Date('2026-10-30T21:50:00.000Z')), '清晨');
    assert.equal(timeOfDayLabel(new Date('2026-10-31T12:00:00.000Z')), '晚上');
  });
});
