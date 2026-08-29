import { z } from 'zod';

const optionalText = (max = 160) => z.string().trim().min(1).max(max).optional();
const MAX_TOOL_RESULT_LIMIT = 30;
// `limit` do model sinh ra: yêu cầu 40/50/100 vẫn là câu hỏi hợp lệ. Chuẩn hóa về
// trần an toàn thay vì để Zod từ chối cả lượt truy vấn và trả lỗi kỹ thuật cho user.
const optionalLimit = z.coerce
    .number()
    .int()
    .min(1)
    .transform((value) => Math.min(value, MAX_TOOL_RESULT_LIMIT))
    .optional();
const period = z.enum(['today', 'yesterday', 'week', 'month', 'all']).optional();
const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional();
const stringArray = <T extends [string, ...string[]]>(values: T) =>
    z.preprocess((value) => (typeof value === 'string' ? [value] : value), z.array(z.enum(values)).max(10)).optional();

const requestBase = {
    search: optionalText(300),
    requestCode: optionalText(80),
    status: optionalText(60),
    plantName: optionalText(160),
    materialName: optionalText(200),
    period,
    startDate: date,
    endDate: date,
};

export const ASSISTANT_TOOL_SCHEMAS = {
    search_assets: z.object({
        search: optionalText(200),
        status: stringArray([
            'active',
            'maintenance',
            'broken',
            'borrowing',
            'loaned_out',
            'storage',
            'pending_disposal',
            'disposed',
            'returned_to_partner',
        ]),
        ownershipType: stringArray(['owned', 'partner_borrowed', 'rental']),
        plantName: optionalText(),
        brandName: optionalText(),
        area: optionalText(),
        flags: stringArray(['overdue_maintenance', 'mislocated', 'no_qr', 'not_scanned']),
        aggregate: z.enum(['count', 'sum_value', 'breakdown_by_status', 'breakdown_by_plant']).optional(),
        limit: optionalLimit,
    }),
    locate_asset: z.object({ query: z.string().trim().min(1).max(200) }),
    transfer_orders: z.object({
        period: z.enum(['today', 'yesterday', 'week', 'month']).optional(),
        status: z.enum(['pending', 'approved', 'completed', 'rejected', 'cancelled']).optional(),
        plantName: optionalText(),
        limit: optionalLimit,
    }),
    draft_transfer: z.object({
        machineRefs: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
        toPlantName: optionalText(),
    }),
    draft_maintenance: z.object({
        machineRefs: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
        description: optionalText(1000),
        type: z.enum(['periodic', 'emergency', 'inspection']).optional(),
        repairMode: z.enum(['internal', 'external']).optional(),
        technician: optionalText(160),
        note: optionalText(500),
    }),
    top_broken_assets: z.object({ plantName: optionalText(), limit: optionalLimit }),
    maintenance_tickets: z.object({
        status: z.enum(['pending', 'in_progress', 'completed', 'overdue', 'cancelled', 'open']).optional(),
        overdue: z.boolean().optional(),
        overdueDays: z.coerce.number().int().min(1).max(365).optional(),
        repairMode: z.enum(['internal', 'external']).optional(),
        approvalPending: z.boolean().optional(),
        plantName: optionalText(),
        machineRef: optionalText(),
        period,
        limit: optionalLimit,
    }),
    borrowed_machines: z.object({}),
    low_stock_materials: z.object({ limit: optionalLimit }),
    top_used_materials: z.object({ limit: optionalLimit }),
    search_materials: z.object({ search: optionalText(200), category: optionalText(), limit: optionalLimit }),
    draft_supply_request: z.object({
        items: z
            .array(
                z.object({
                    materialRef: z.string().trim().min(1).max(240),
                    quantity: z.coerce.number().positive().max(100000000),
                    unit: optionalText(80),
                    note: optionalText(500),
                })
            )
            .min(1)
            .max(30),
        purpose: z.string().trim().min(3).max(500),
        plantName: optionalText(),
    }),
    draft_purchase_request: z.object({
        items: z
            .array(
                z.object({
                    materialRef: z.string().trim().min(1).max(240),
                    quantity: z.coerce.number().positive().max(100000000),
                    unit: optionalText(80),
                    note: optionalText(500),
                })
            )
            .min(1)
            .max(30),
        purpose: optionalText(500),
        proposedBy: optionalText(180),
        plantName: optionalText(),
    }),
    material_usage_by_plant: z.object({
        plantName: optionalText(),
        materialName: optionalText(200),
        period,
        limit: optionalLimit,
    }),
    purchase_analysis: z.object({
        period,
        groupBy: z.enum(['material', 'supplier']).optional(),
        plantName: optionalText(),
        limit: optionalLimit,
    }),
    purchase_orders: z.object({
        search: optionalText(240),
        orderCode: optionalText(80),
        supplierName: optionalText(180),
        plantName: optionalText(),
        status: optionalText(60),
        period,
        limit: optionalLimit,
    }),
    material_price_history: z.object({ materialName: z.string().trim().min(1).max(200), limit: optionalLimit }),
    supplier_comparison: z.object({ materialName: z.string().trim().min(1).max(200), limit: optionalLimit }),
    distribution_analysis: z.object({ plantName: optionalText(), period, limit: optionalLimit }),
    supply_requests: z.object({ ...requestBase, limit: optionalLimit }),
    supply_request_analysis: z.object({
        ...requestBase,
        staleDays: z.coerce.number().int().min(1).max(365).optional(),
    }),
    purchase_requests: z.object({ ...requestBase, limit: optionalLimit }),
    purchase_request_analysis: z.object({
        ...requestBase,
        staleDays: z.coerce.number().int().min(1).max(365).optional(),
    }),
    request_lifecycle: z
        .object({ requestCode: optionalText(100), search: optionalText(200) })
        .refine((value) => Boolean(value.requestCode || value.search), {
            message: 'Cần mã phiếu hoặc nội dung tìm kiếm',
        }),
    request_backlog: z.object({ period, startDate: date, endDate: date }),
    request_risk_analysis: z.object({ period, startDate: date, endDate: date }),
    purchase_suggestion: z.object({ limit: optionalLimit }),
    cost_variance: z.object({
        metric: z.enum(['repair_cost', 'distribution_cost', 'purchase_cost', 'total_cost', 'maintenance_tickets']),
        period: z.enum(['week', 'month']).optional(),
    }),
    cost_overview: z.object({ period: z.enum(['week', 'month']).optional() }),
    compare_cost: z.object({ period: z.enum(['week', 'month']).optional() }),
    cost_by_plant: z.object({
        metric: z.enum(['total_cost', 'purchase_cost', 'distribution_cost', 'repair_cost']).optional(),
        period: z.enum(['week', 'month']).optional(),
    }),
    summary_metrics: z.object({}),
} as const;

export type AssistantToolName = keyof typeof ASSISTANT_TOOL_SCHEMAS;

export const ASSISTANT_TOOL_NAMES = Object.keys(ASSISTANT_TOOL_SCHEMAS) as AssistantToolName[];

export const ASSISTANT_TOOL_SUMMARY: Record<AssistantToolName, string> = {
    search_assets: 'Tìm, đếm, lọc và tổng hợp máy',
    locate_asset: 'Tra cứu vị trí và lịch sử một máy',
    transfer_orders: 'Danh sách lệnh điều chuyển',
    draft_transfer: 'Soạn nháp lệnh điều chuyển, chưa ghi dữ liệu',
    draft_maintenance: 'Soạn nháp phiếu bảo trì cho một hoặc nhiều máy',
    top_broken_assets: 'Máy phát sinh phiếu hỏng/bảo trì nhiều',
    maintenance_tickets: 'Tra cứu và phân tích phiếu bảo trì',
    borrowed_machines: 'Máy mượn/thuê và hạn trả đối tác',
    low_stock_materials: 'Vật tư dưới định mức tồn',
    top_used_materials: 'Vật tư cấp phát nhiều',
    search_materials: 'Tìm danh mục vật tư',
    draft_supply_request: 'Soạn đề xuất cấp vật tư, chưa ghi dữ liệu',
    draft_purchase_request: 'Soạn đề xuất mua vật tư, chưa ghi dữ liệu',
    material_usage_by_plant: 'Mức sử dụng vật tư theo cơ sở',
    purchase_analysis: 'Phân tích chi phí mua theo vật tư/NCC',
    purchase_orders: 'Tra cứu đơn đặt hàng',
    material_price_history: 'Lịch sử giá một vật tư',
    supplier_comparison: 'So sánh nhà cung cấp một vật tư',
    distribution_analysis: 'Cấp phát, giá trị và thiếu hụt',
    supply_requests: 'Danh sách phiếu đề xuất cấp',
    supply_request_analysis: 'Phân tích phiếu đề xuất cấp',
    purchase_requests: 'Danh sách phiếu đề xuất mua',
    purchase_request_analysis: 'Phân tích phiếu đề xuất mua',
    request_lifecycle: 'Vòng đời một phiếu YC/DX/KT',
    request_backlog: 'Điểm nghẽn đề xuất cấp và mua',
    request_risk_analysis: 'Rủi ro và hành động ưu tiên của đề xuất',
    purchase_suggestion: 'Gợi ý mua từ tồn và tiêu hao',
    cost_variance: 'Biến động một chỉ số chi phí',
    cost_overview: 'Tổng quan mua, cấp phát và sửa ngoài',
    compare_cost: 'So sánh mua và cấp phát',
    cost_by_plant: 'Xếp hạng chi phí theo cơ sở',
    summary_metrics: 'Chỉ số tổng quan hệ thống',
};

const ASSISTANT_TOOL_ARGUMENT_GUIDE: Record<AssistantToolName, string> = {
    search_assets:
        '{search?, status?:string[], ownershipType?:string[], plantName?, brandName?, area?, flags?:string[], aggregate?, limit?}',
    locate_asset: '{query}',
    transfer_orders: '{period?:today|yesterday|week|month, status?, plantName?, limit?}',
    draft_transfer: '{machineRefs:string[], toPlantName?}',
    draft_maintenance: '{machineRefs:string[], description?, type?, repairMode?, technician?, note?}',
    top_broken_assets: '{plantName?, limit?}',
    maintenance_tickets:
        '{status?, overdue?, overdueDays?, repairMode?:internal|external, approvalPending?, plantName?, machineRef?, period?, limit?}',
    borrowed_machines: '{}',
    low_stock_materials: '{limit?}',
    top_used_materials: '{limit?}',
    search_materials: '{search?, category?, limit?}',
    draft_supply_request: '{items:[{materialRef,quantity,unit?,note?}], purpose, plantName?}',
    draft_purchase_request: '{items:[{materialRef,quantity,unit?,note?}], purpose?, proposedBy?, plantName?}',
    material_usage_by_plant: '{plantName?, materialName?, period?, limit?}',
    purchase_analysis: '{period?, groupBy?:material|supplier, plantName?, limit?}',
    purchase_orders: '{search?, orderCode?, supplierName?, plantName?, status?, period?, limit?}',
    material_price_history: '{materialName, limit?}',
    supplier_comparison: '{materialName, limit?}',
    distribution_analysis: '{plantName?, period?, limit?}',
    supply_requests:
        '{search?, requestCode?, status?, plantName?, materialName?, period?, startDate?, endDate?, limit?}',
    supply_request_analysis:
        '{search?, requestCode?, status?, plantName?, materialName?, period?, startDate?, endDate?, staleDays?}',
    purchase_requests:
        '{search?, requestCode?, status?, plantName?, materialName?, period?, startDate?, endDate?, limit?}',
    purchase_request_analysis:
        '{search?, requestCode?, status?, plantName?, materialName?, period?, startDate?, endDate?, staleDays?}',
    request_lifecycle: '{requestCode? hoặc search?; bắt buộc một trường}',
    request_backlog: '{period?, startDate?, endDate?}',
    request_risk_analysis: '{period?, startDate?, endDate?}',
    purchase_suggestion: '{limit?}',
    cost_variance: '{metric, period?:week|month}',
    cost_overview: '{period?:week|month}',
    compare_cost: '{period?:week|month}',
    cost_by_plant: '{metric?:total_cost|purchase_cost|distribution_cost|repair_cost, period?:week|month}',
    summary_metrics: '{}',
};

export const validateAssistantToolArgs = (tool: AssistantToolName, args: unknown): Record<string, any> => {
    const source = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    // Nhiều model JSON điền null cho field tùy chọn. Coi null như "không truyền" để tránh từ chối tool hợp lệ.
    const withoutNulls = Object.fromEntries(Object.entries(source).filter(([, value]) => value != null));
    return ASSISTANT_TOOL_SCHEMAS[tool].parse(withoutNulls);
};

export const compactAssistantToolCatalog = (allowedTools: string[]) =>
    allowedTools
        .filter((tool): tool is AssistantToolName => tool in ASSISTANT_TOOL_SCHEMAS)
        .map((tool) => `${tool}: ${ASSISTANT_TOOL_SUMMARY[tool]}; args=${ASSISTANT_TOOL_ARGUMENT_GUIDE[tool]}`)
        .join('\n');
