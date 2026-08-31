import assert from 'node:assert/strict';
import { routeAssistantQuestion } from '../src/services/ai-agent.service';

type ExpectedArgs = Record<string, unknown>;

const cases: Array<{ question: string; expected: ExpectedArgs }> = [
    // Tổng quan và phân biệt chiều giao dịch.
    { question: 'Hiện có bao nhiêu máy đang cho đối tác mượn?', expected: { direction: 'outbound', status: 'active' } },
    { question: 'Danh sách máy Hải Đăng đang cho mượn.', expected: { direction: 'outbound', status: 'active' } },
    { question: 'Đối tác đang giữ máy nào của mình?', expected: { direction: 'outbound', status: 'active' } },
    { question: 'Máy nào hiện ở bên đối tác?', expected: { direction: 'outbound', status: 'active' } },
    { question: 'Có bao nhiêu máy đang mượn của đối tác?', expected: { direction: 'inbound', status: 'active' } },
    { question: 'Liệt kê máy thuê của bên ngoài.', expected: { direction: 'inbound' } },
    { question: 'Máy mượn của đối tác hiện còn bao nhiêu?', expected: { direction: 'inbound' } },
    { question: 'Tình hình máy mượn và máy cho mượn hiện tại?', expected: { direction: 'all' } },
    { question: 'Tổng hợp các lô mượn và cho mượn máy.', expected: { direction: 'all' } },
    { question: 'Bên nào đang giữ máy của Hải Đăng?', expected: { direction: 'outbound', status: 'active' } },

    // Trạng thái workflow của lô.
    { question: 'Lô cho mượn nào đang chờ duyệt?', expected: { direction: 'outbound', status: 'pending_approval' } },
    {
        question: 'Lô máy cho mượn nào đang chờ phê duyệt?',
        expected: { direction: 'outbound', status: 'pending_approval' },
    },
    {
        question: 'Có lô cho mượn nào đợi duyệt không?',
        expected: { direction: 'outbound', status: 'pending_approval' },
    },
    { question: 'Các lô cho mượn đã duyệt nhưng chưa giao.', expected: { direction: 'outbound', status: 'approved' } },
    { question: 'Lô máy nào đang chờ bàn giao cho đối tác?', expected: { direction: 'outbound', status: 'approved' } },
    {
        question: 'Cho tôi các lô máy cho mượn đã phê duyệt và đợi giao.',
        expected: { direction: 'outbound', status: 'approved' },
    },
    { question: 'Lô mượn nào đang tiếp nhận máy?', expected: { direction: 'inbound', status: 'receiving' } },
    { question: 'Lô thuê nào nhận chưa đủ?', expected: { direction: 'inbound', status: 'receiving' } },
    { question: 'Lô cho mượn nào đang ở bản nháp?', expected: { direction: 'outbound', status: 'draft' } },
    { question: 'Các lô máy cho mượn đang soạn.', expected: { direction: 'outbound', status: 'draft' } },
    { question: 'Lô cho mượn nào đã trả một phần?', expected: { direction: 'outbound', status: 'partially_returned' } },
    {
        question: 'Đối tác đã hoàn trả một phần máy ở lô nào?',
        expected: { direction: 'outbound', status: 'partially_returned' },
    },
    { question: 'Các lô cho mượn đã thu hồi đủ.', expected: { direction: 'outbound', status: 'returned' } },
    { question: 'Lịch sử lô máy cho mượn đã hủy.', expected: { direction: 'outbound', status: 'cancelled' } },
    { question: 'Lô cho mượn nào bị từ chối?', expected: { direction: 'outbound', status: 'rejected' } },

    // Hạn trả và cảnh báo.
    { question: 'Máy cho mượn nào đã quá hạn trả?', expected: { direction: 'outbound', dueState: 'overdue' } },
    { question: 'Có lô máy thuê nào trễ hạn không?', expected: { direction: 'inbound', dueState: 'overdue' } },
    { question: 'Đối tác nào giữ máy quá ngày trả?', expected: { direction: 'outbound', dueState: 'overdue' } },
    { question: 'Máy mượn nào đã hết hạn?', expected: { direction: 'inbound', dueState: 'overdue' } },
    { question: 'Lô cho mượn nào sắp đến hạn?', expected: { direction: 'outbound', dueState: 'due_soon' } },
    { question: '7 ngày tới có máy cho mượn nào phải trả?', expected: { direction: 'outbound', dueState: 'due_soon' } },
    { question: 'Máy thuê nào gần đến ngày trả?', expected: { direction: 'inbound', dueState: 'due_soon' } },
    { question: 'Lô mượn nào chưa có hạn trả?', expected: { direction: 'inbound', dueState: 'missing_due' } },
    { question: 'Tìm các lô cho mượn thiếu hạn trả.', expected: { direction: 'outbound', dueState: 'missing_due' } },

    // Mã lô, mã máy và serial.
    { question: 'Lô cho mượn LO-20260828-001 gồm những máy nào?', expected: { batchCode: 'LO-20260828-001' } },
    { question: 'LO-20260828-001 đã giao bao nhiêu và trả bao nhiêu máy?', expected: { batchCode: 'LO-20260828-001' } },
    { question: 'Tình trạng lô LO-20260828-001 hiện tại?', expected: { batchCode: 'LO-20260828-001' } },
    {
        question: 'Máy URE-KASU-HD-001 có đang cho mượn không?',
        expected: { direction: 'outbound', machineRef: 'URE-KASU-HD-001' },
    },
    {
        question: 'Serial 170224002 đang nằm trong lô mượn nào?',
        expected: { direction: 'inbound', machineRef: '170224002' },
    },
    {
        question: 'Tra lịch sử cho mượn của máy 2KMX-JUKI-HD-005.',
        expected: { direction: 'outbound', machineRef: '2KMX-JUKI-HD-005' },
    },

    // Đối tác, cơ sở và thời gian.
    {
        question: 'Hải Đăng đang cho Công ty ABC mượn bao nhiêu máy?',
        expected: { direction: 'outbound', partnerName: 'ABC' },
    },
    { question: 'Bên Minh Anh đang giữ máy nào?', expected: { direction: 'outbound', partnerName: 'Minh Anh' } },
    {
        question: 'Máy mượn của Công ty Sao Mai còn những máy nào?',
        expected: { direction: 'inbound', partnerName: 'Sao Mai' },
    },
    { question: 'Các lô cho đối tác Hưng Phát mượn.', expected: { direction: 'outbound', partnerName: 'Hưng Phát' } },
    { question: 'Tháng này có những lô máy cho mượn nào?', expected: { direction: 'outbound', period: 'month' } },
    { question: 'Tuần này Cơ Sở 1 cho mượn những máy nào?', expected: { direction: 'outbound', period: 'week' } },
    { question: 'Hôm nay có bàn giao máy cho đối tác không?', expected: { direction: 'outbound', period: 'today' } },
    {
        question: 'Hôm qua nhận lại máy cho mượn nào?',
        expected: { direction: 'outbound', status: 'returned', period: 'yesterday' },
    },
    {
        question: 'Từ 01/08/2026 đến 20/08/2026 đã cho mượn những máy nào?',
        expected: { direction: 'outbound', startDate: '2026-08-01', endDate: '2026-08-20' },
    },
];

for (const { question, expected } of cases) {
    const routed = routeAssistantQuestion(question);
    assert.equal(routed?.tool, 'borrowed_machines', `Sai tool: ${question}`);
    for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(routed?.args?.[key], value, `Sai ${key}: ${question}`);
    }
}

console.log(`AI borrowing question regression: ${cases.length}/${cases.length} OK`);
