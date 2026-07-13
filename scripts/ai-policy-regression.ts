import assert from 'node:assert/strict';
import { USER_ROLE } from '../src/constant/allowedRoles';
import {
    AssistantPolicyError,
    allowedAssistantTools,
    assertAssistantToolAccess,
    canUseAssistantTool,
    type AssistantContext,
} from '../src/services/ai/assistant-policy.service';
import { endOfVietnamDay, startOfVietnamDay, vietnamDateLabel } from '../src/utils/vietnamDate';
import { detectAssistantDateSelection } from '../src/services/ai/assistant-date.service';
import { ASSISTANT_TOOL_NAMES, validateAssistantToolArgs } from '../src/services/ai/assistant-tool-registry.service';
import { buildGroundingEvidence, mergeAssistantRenders } from '../src/services/ai/assistant-evidence.service';
import { redactAssistantText } from '../src/services/ai/assistant-trace.service';
import { routeAssistantQuestion } from '../src/services/ai-agent.service';

const context = (role: USER_ROLE, overrides: Partial<AssistantContext> = {}): AssistantContext => ({
    userId: '000000000000000000000001',
    role,
    plantId: '000000000000000000000010',
    plantName: 'Cơ Sở 2',
    permissions: [],
    canAccessProcurement: false,
    ...overrides,
});

const expectDenied = (tool: string, ctx: AssistantContext) => {
    assert.equal(canUseAssistantTool(tool, ctx), false, `${tool} phải bị từ chối`);
    assert.throws(
        () => assertAssistantToolAccess(tool, ctx),
        (error: unknown) => error instanceof AssistantPolicyError && error.code === 'forbidden'
    );
};

const staff = context(USER_ROLE.STAFF);
assert.equal(canUseAssistantTool('search_assets', staff), true);
assert.equal(canUseAssistantTool('maintenance_tickets', staff), true);
assert.equal(canUseAssistantTool('draft_maintenance', staff), true);
assert.equal(canUseAssistantTool('supply_requests', staff), true);
expectDenied('cost_overview', staff);
expectDenied('purchase_orders', staff);
expectDenied('draft_transfer', staff);
expectDenied('borrowed_machines', staff);

const manager = context(USER_ROLE.MANAGER);
assert.equal(canUseAssistantTool('draft_transfer', manager), true);
assert.equal(canUseAssistantTool('distribution_analysis', manager), true);
assert.equal(canUseAssistantTool('draft_supply_request', manager), true);
expectDenied('cost_overview', manager);
expectDenied('purchase_orders', manager);

const procurementManager = context(USER_ROLE.MANAGER, { canAccessProcurement: true });
assert.equal(canUseAssistantTool('purchase_orders', procurementManager), true);
assert.equal(canUseAssistantTool('purchase_request_analysis', procurementManager), true);
assert.equal(canUseAssistantTool('draft_purchase_request', procurementManager), true);

const director = context(USER_ROLE.DIRECTOR);
assert.equal(canUseAssistantTool('cost_overview', director), true);
assert.equal(canUseAssistantTool('cost_by_plant', director), true);
expectDenied('purchase_orders', director);

const procurementDirector = context(USER_ROLE.DIRECTOR, { canAccessProcurement: true });
assert.equal(canUseAssistantTool('purchase_orders', procurementDirector), true);
const fullAccess = context(USER_ROLE.ADMIN, { canAccessProcurement: true });
assert.deepEqual([...allowedAssistantTools(fullAccess)].sort(), [...ASSISTANT_TOOL_NAMES].sort());

// 03:00 ngày 13/07 ở Việt Nam vẫn phải lọc từ 17:00 UTC ngày hôm trước.
const vietnamMorning = new Date('2026-07-12T20:00:00.000Z');
assert.equal(vietnamDateLabel(vietnamMorning), '13/07/2026');
assert.equal(startOfVietnamDay(vietnamMorning).toISOString(), '2026-07-12T17:00:00.000Z');
assert.equal(endOfVietnamDay(vietnamMorning).toISOString(), '2026-07-13T16:59:59.999Z');
assert.deepEqual(detectAssistantDateSelection('Hôm nay có phiếu đề xuất cấp nào?', vietnamMorning), {
    period: 'today',
});
assert.deepEqual(detectAssistantDateSelection('Phiếu từ 01/07/2026 đến 12/07/2026', vietnamMorning), {
    startDate: '2026-07-01',
    endDate: '2026-07-12',
});
assert.deepEqual(detectAssistantDateSelection('Phiếu ngày 31/02/2026', vietnamMorning), {});

assert.ok(ASSISTANT_TOOL_NAMES.length >= 29, 'Tool Registry phải bao phủ toàn bộ tool vận hành');
assert.deepEqual(validateAssistantToolArgs('search_assets', { status: 'broken', limit: '5' }), {
    status: ['broken'],
    limit: 5,
});
assert.deepEqual(validateAssistantToolArgs('search_assets', { status: null, plantName: null }), {});
assert.throws(() => validateAssistantToolArgs('cost_variance', { metric: 'made_up_cost' }));
assert.throws(() => validateAssistantToolArgs('draft_transfer', { machineRefs: [] }));
assert.deepEqual(
    validateAssistantToolArgs('draft_maintenance', {
        machineRefs: ['URE-KASU-HD-001'],
        type: 'emergency',
        repairMode: 'internal',
    }),
    { machineRefs: ['URE-KASU-HD-001'], type: 'emergency', repairMode: 'internal' }
);
assert.deepEqual(
    validateAssistantToolArgs('draft_supply_request', {
        items: [{ materialRef: 'Giấy A4', quantity: '10', unit: 'Ram' }],
        purpose: 'Phục vụ văn phòng',
    }),
    {
        items: [{ materialRef: 'Giấy A4', quantity: 10, unit: 'Ram' }],
        purpose: 'Phục vụ văn phòng',
    }
);
assert.throws(() =>
    validateAssistantToolArgs('draft_purchase_request', {
        items: [{ materialRef: 'Giấy A4', quantity: 0 }],
    })
);

const merged = mergeAssistantRenders(
    { domain: 'asset', count: 2, items: [{ id: 'a1' }], aggregates: { assets: { total: 2 } } },
    { domain: 'cost', count: 1, items: [{ id: 'c1' }], aggregates: { costs: { total: 1000 } } }
);
assert.equal(merged?.domain, 'mixed');
assert.equal(merged?.items.length, 2);
assert.equal(merged?.aggregates.assets.total, 2);
assert.equal(merged?.aggregates.costs.total, 1000);
assert.doesNotThrow(() =>
    JSON.parse(
        buildGroundingEvidence([{ tool: 'summary_metrics', data: { totalMachines: 12, note: 'x'.repeat(3000) } }], 500)
    )
);

const redacted = redactAssistantText(
    'password: matkhau123 token=secret-token-123456 email=hieu707203@gmail.com Bearer abc.def.ghi'
);
assert.equal(redacted.includes('matkhau123'), false);
assert.equal(redacted.includes('secret-token-123456'), false);
assert.equal(redacted.includes('hieu707203@gmail.com'), false);
assert.equal(redacted.includes('Bearer abc.def.ghi'), false);
assert.equal(routeAssistantQuestion('Hôm nay có phiếu đề xuất cấp vật tư nào không?')?.tool, 'supply_requests');
assert.equal(routeAssistantQuestion('So sánh chi phí mua và cấp phát tháng này.')?.tool, 'compare_cost');
assert.equal(routeAssistantQuestion('Tạo lệnh điều chuyển máy URE-KASU-HD-001 sang Cơ Sở 2.')?.tool, 'draft_transfer');
assert.equal(routeAssistantQuestion('Tạo phiếu bảo trì máy URE-KASU-HD-001 sửa ngoài.')?.tool, 'draft_maintenance');
assert.equal(routeAssistantQuestion('Tạo phiếu đề xuất cấp 10 ram giấy A4.'), null);

console.log('AI assistant policy regression: OK');
