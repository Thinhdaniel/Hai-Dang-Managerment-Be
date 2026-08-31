import { USER_ROLE } from '@/constant/allowedRoles';
import Plant from '@/models/Plant';
import Brand from '@/models/Brand';
import { getUserPlantId } from '@/services/material-workflow.helpers';
import type { Request } from 'express';
import {
    ASSISTANT_TOOL_SCHEMAS,
    validateAssistantToolArgs,
    type AssistantToolName,
} from '@/services/ai/assistant-tool-registry.service';

export type AssistantContext = {
    userId: string;
    role: USER_ROLE;
    plantId?: string;
    plantName?: string;
    permissions: string[];
    canAccessProcurement: boolean;
};

type ToolAccess = 'field' | 'management' | 'director' | 'procurement';

const MANAGEMENT_ROLES = new Set<USER_ROLE>([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR, USER_ROLE.MANAGER]);
const DIRECTOR_ROLES = new Set<USER_ROLE>([USER_ROLE.ADMIN, USER_ROLE.DIRECTOR]);

const TOOL_ACCESS: Record<string, ToolAccess> = {
    search_assets: 'field',
    locate_asset: 'field',
    transfer_orders: 'field',
    draft_transfer: 'management',
    draft_maintenance: 'field',
    top_broken_assets: 'field',
    maintenance_tickets: 'field',
    borrowed_machines: 'management',
    search_materials: 'field',
    draft_supply_request: 'management',
    draft_purchase_request: 'procurement',
    low_stock_materials: 'field',
    top_used_materials: 'field',
    material_usage_by_plant: 'management',
    distribution_analysis: 'management',
    supply_requests: 'field',
    supply_request_analysis: 'field',
    purchase_requests: 'procurement',
    purchase_request_analysis: 'procurement',
    request_lifecycle: 'field',
    request_backlog: 'procurement',
    request_risk_analysis: 'procurement',
    purchase_analysis: 'procurement',
    purchase_orders: 'procurement',
    material_price_history: 'procurement',
    supplier_comparison: 'procurement',
    purchase_suggestion: 'management',
    cost_variance: 'director',
    cost_overview: 'director',
    compare_cost: 'director',
    cost_by_plant: 'director',
    summary_metrics: 'field',
};

const TOOL_LABEL: Record<ToolAccess, string> = {
    field: 'dữ liệu vận hành',
    management: 'dữ liệu dành cho cấp quản lý',
    director: 'dữ liệu chi phí dành cho Giám đốc',
    procurement: 'dữ liệu mua hàng',
};

const PLANT_AWARE_TOOLS = new Set([
    'search_assets',
    'transfer_orders',
    'top_broken_assets',
    'maintenance_tickets',
    'borrowed_machines',
    'draft_supply_request',
    'draft_purchase_request',
    'material_usage_by_plant',
    'distribution_analysis',
    'supply_requests',
    'supply_request_analysis',
    'purchase_requests',
    'purchase_request_analysis',
    'purchase_analysis',
    'purchase_orders',
]);

const OWN_PLANT_SCOPED_TOOLS = new Set(['supply_requests', 'supply_request_analysis', 'request_lifecycle']);

export class AssistantPolicyError extends Error {
    readonly code: 'forbidden' | 'invalid_scope' | 'not_found';

    constructor(code: AssistantPolicyError['code'], message: string) {
        super(message);
        this.name = 'AssistantPolicyError';
        this.code = code;
    }
}

export const isAssistantPolicyError = (error: unknown): error is AssistantPolicyError =>
    error instanceof AssistantPolicyError;

const normalize = (value?: string) =>
    (value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();

const expandPlantAlias = (value?: string) => normalize(value).replace(/\bc\.?\s*s\.?\s*(\d+)/g, 'co so $1');

const validDateArg = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const resolveNamedEntity = <T extends { id: string; name: string }>(items: T[], input?: string): T | undefined => {
    if (!input) return undefined;
    const query = expandPlantAlias(input);
    return (
        items.find((item) => expandPlantAlias(item.name) === query) ||
        items.find((item) => {
            const name = expandPlantAlias(item.name);
            return name.includes(query) || query.includes(name);
        })
    );
};

export const buildAssistantContext = (req: Request): AssistantContext => {
    const role = (req.role || USER_ROLE.STAFF) as USER_ROLE;
    const plantId = getUserPlantId(req);
    const user = req.user && typeof req.user === 'object' ? req.user : {};
    const plantName = user?.plantId && typeof user.plantId === 'object' ? String(user.plantId.name || '') : undefined;
    const permissions = Array.isArray(user?.permission) ? user.permission.map(String) : [];
    const configuredProcurementPlants = (process.env.PROCUREMENT_PLANT_IDS || process.env.MAIN_PLANT_ID || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    const canAccessProcurement = Boolean(
        MANAGEMENT_ROLES.has(role) && plantId && configuredProcurementPlants.includes(plantId)
    );

    return {
        userId: String(req.userId || ''),
        role,
        plantId,
        plantName: plantName || undefined,
        permissions,
        canAccessProcurement,
    };
};

export const canUseAssistantTool = (tool: string, context: AssistantContext) => {
    const access = TOOL_ACCESS[tool] || 'director';
    if (access === 'field') return true;
    if (access === 'management') return MANAGEMENT_ROLES.has(context.role);
    if (access === 'director') return DIRECTOR_ROLES.has(context.role);
    return context.canAccessProcurement;
};

export const assertAssistantToolAccess = (tool: string, context: AssistantContext) => {
    if (canUseAssistantTool(tool, context)) return;
    const access = TOOL_ACCESS[tool] || 'director';
    const suffix = access === 'procurement' ? ' tại cơ sở được cấu hình mua hàng' : '';
    throw new AssistantPolicyError(
        'forbidden',
        `Bạn không có quyền truy cập ${TOOL_LABEL[access]}${suffix}. Trợ lý đã dừng truy vấn để bảo vệ dữ liệu.`
    );
};

export const allowedAssistantTools = (context: AssistantContext) =>
    Object.keys(TOOL_ACCESS).filter((tool) => canUseAssistantTool(tool, context));

export const prepareAssistantToolCall = async (
    tool: string,
    rawArgs: unknown,
    context: AssistantContext
): Promise<Record<string, any>> => {
    assertAssistantToolAccess(tool, context);
    if (!(tool in ASSISTANT_TOOL_SCHEMAS)) {
        throw new AssistantPolicyError('invalid_scope', `Tool “${tool}” không tồn tại trong hệ thống.`);
    }
    let args: Record<string, any>;
    try {
        args = validateAssistantToolArgs(tool as AssistantToolName, rawArgs);
    } catch {
        throw new AssistantPolicyError(
            'invalid_scope',
            `Tham số truy vấn của “${tool}” chưa hợp lệ. Trợ lý cần phân tích lại câu hỏi.`
        );
    }

    for (const field of ['startDate', 'endDate']) {
        if (args[field] != null && !validDateArg(args[field])) {
            throw new AssistantPolicyError(
                'invalid_scope',
                `Khoảng ngày không hợp lệ (${field}). Hãy dùng định dạng ngày/tháng/năm hoặc YYYY-MM-DD.`
            );
        }
    }
    if (args.startDate && args.endDate && args.startDate > args.endDate) {
        throw new AssistantPolicyError('invalid_scope', 'Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc.');
    }

    if (tool === 'request_lifecycle') {
        const requestRef = normalize(String(args.requestCode || args.search || ''));
        if (requestRef.startsWith('dx') && !context.canAccessProcurement) {
            throw new AssistantPolicyError(
                'forbidden',
                'Bạn không có quyền xem vòng đời phiếu đề xuất mua. Trợ lý đã dừng truy vấn để bảo vệ dữ liệu mua hàng.'
            );
        }
        if (requestRef.startsWith('kt') && context.role === USER_ROLE.STAFF) {
            args.scopeUserId = context.userId;
        }
    }

    if (PLANT_AWARE_TOOLS.has(tool) && args.plantName) {
        const plants = await Plant.find({ isDeleted: { $ne: true } })
            .select('_id name code')
            .lean();
        const options = plants.map((plant: any) => ({
            id: String(plant._id),
            name: String(plant.name || plant.code || ''),
        }));
        const matched = resolveNamedEntity(options, String(args.plantName));
        if (!matched) {
            throw new AssistantPolicyError(
                'not_found',
                `Không tìm thấy cơ sở “${String(args.plantName).slice(0, 80)}”. Trợ lý không tự bỏ bộ lọc để truy vấn toàn hệ thống.`
            );
        }
        args.plantName = matched.name;
        args._resolvedPlantId = matched.id;
    }

    if (tool === 'search_assets' && args.brandName) {
        const brands = await Brand.find({ isDeleted: { $ne: true } })
            .select('_id name')
            .lean();
        const options = brands.map((brand: any) => ({ id: String(brand._id), name: String(brand.name || '') }));
        const matched = resolveNamedEntity(options, String(args.brandName));
        if (!matched) {
            throw new AssistantPolicyError(
                'not_found',
                `Không tìm thấy hãng “${String(args.brandName).slice(0, 80)}”. Hãy kiểm tra lại tên hãng.`
            );
        }
        args.brandName = matched.name;
    }

    if (context.role === USER_ROLE.STAFF && OWN_PLANT_SCOPED_TOOLS.has(tool)) {
        if (!context.plantId || !context.plantName) {
            throw new AssistantPolicyError(
                'invalid_scope',
                'Tài khoản chưa được gán cơ sở nên trợ lý không thể truy vấn dữ liệu theo phạm vi an toàn.'
            );
        }
        if (args._resolvedPlantId && args._resolvedPlantId !== context.plantId) {
            throw new AssistantPolicyError(
                'forbidden',
                'Bạn chỉ được xem phiếu thuộc cơ sở của mình. Trợ lý đã dừng truy vấn cơ sở khác.'
            );
        }
        args.plantName = context.plantName;
        args._resolvedPlantId = context.plantId;
        args.scopePlantId = context.plantId;
    }

    return args;
};
