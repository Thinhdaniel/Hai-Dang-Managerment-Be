import assert from 'node:assert/strict';
import test from 'node:test';
import {
    defaultProductionScheduleForWeekday,
    productionWeekdayFromDate,
    summarizeProductionScheduleSlots,
} from '../production-schedule.helpers';

test('xác định đúng Thứ Bảy mà không phụ thuộc timezone máy chủ', () => {
    assert.equal(productionWeekdayFromDate('2026-09-12'), 6);
    assert.equal(productionWeekdayFromDate('2026-09-14'), 1);
});

test('Thứ Bảy có 8 giờ thường và tăng ca từ 17h mặc định tắt', () => {
    const schedule = defaultProductionScheduleForWeekday(6);
    const summary = summarizeProductionScheduleSlots(schedule.timeSlots);
    const slotsFrom17 = schedule.timeSlots.filter((slot) => slot.startMinute >= 17 * 60);

    assert.equal(schedule.isWorkingDay, true);
    assert.equal(summary.regularMinutes, 8 * 60);
    assert.equal(summary.overtimeMinutes, 0);
    assert.ok(slotsFrom17.length > 0);
    assert.ok(slotsFrom17.every((slot) => slot.kind === 'overtime' && !slot.isActive));
});

test('ngày thường không bị nhiễm lịch Thứ Bảy', () => {
    const monday = defaultProductionScheduleForWeekday(1);
    const summary = summarizeProductionScheduleSlots(monday.timeSlots);
    const slot1718 = monday.timeSlots.find((slot) => slot.startMinute === 17 * 60);

    assert.equal(summary.regularMinutes, 9 * 60);
    assert.equal(slot1718?.kind, 'regular');
    assert.equal(slot1718?.isActive, true);
});

test('Chủ Nhật mặc định không phát sinh khung cần nhập', () => {
    const sunday = defaultProductionScheduleForWeekday(0);
    assert.equal(sunday.isWorkingDay, false);
    assert.ok(sunday.timeSlots.every((slot) => !slot.isActive));
});
