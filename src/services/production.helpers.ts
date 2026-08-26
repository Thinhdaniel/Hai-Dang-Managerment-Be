const toId = (value: any): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const toIso = (value: any): string | undefined => (value ? new Date(value).toISOString() : undefined);

const actorName = (value: any): string | undefined => {
    if (!value || typeof value === 'string') return undefined;
    return value.fullname || value.username || value.email || undefined;
};

const serializeActor = (value: any) => {
    const id = toId(value);
    return id ? { id, name: actorName(value) } : undefined;
};

/**
 * Nhãn khung giờ luôn được sinh từ mốc phút, không nhận từ client.
 * Nhờ vậy nhãn không bao giờ lệch với giờ thực và mọi màn hình + Excel đọc
 * cùng một dạng "7-8h". Người dùng chỉ nhập giờ bắt đầu/kết thúc.
 */
export const buildTimeSlotLabel = (startMinute: number, endMinute: number) => {
    // Cả hai tròn giờ thì viết gọn "7-8h"; còn lại ghi đủ đơn vị hai vế
    // ("8h-8h30") để không ra dạng cụt "8-8h30".
    if (startMinute % 60 === 0 && endMinute % 60 === 0) {
        return `${Math.floor(startMinute / 60)}-${Math.floor(endMinute / 60)}h`;
    }
    const full = (minute: number) => {
        const hour = Math.floor(minute / 60);
        const rest = minute % 60;
        return rest === 0 ? `${hour}h` : `${hour}h${String(rest).padStart(2, '0')}`;
    };
    return `${full(startMinute)}-${full(endMinute)}`;
};

// Nhãn ở đây chỉ là giá trị mồi; normalizeTimeSlots luôn sinh lại từ mốc phút.
export const DEFAULT_PRODUCTION_TIME_SLOTS = [
    { key: '08:00', label: '8-9h', startMinute: 480, endMinute: 540, kind: 'regular', isActive: true },
    { key: '09:00', label: '9-10h', startMinute: 540, endMinute: 600, kind: 'regular', isActive: true },
    { key: '10:00', label: '10-11h', startMinute: 600, endMinute: 660, kind: 'regular', isActive: true },
    { key: '11:00', label: '11-12h', startMinute: 660, endMinute: 720, kind: 'regular', isActive: true },
    { key: '13:00', label: '13-14h', startMinute: 780, endMinute: 840, kind: 'regular', isActive: true },
    { key: '14:00', label: '14-15h', startMinute: 840, endMinute: 900, kind: 'regular', isActive: true },
    { key: '15:00', label: '15-16h', startMinute: 900, endMinute: 960, kind: 'regular', isActive: true },
    { key: '16:00', label: '16-17h', startMinute: 960, endMinute: 1020, kind: 'regular', isActive: true },
    { key: '17:00', label: '17-18h', startMinute: 1020, endMinute: 1080, kind: 'regular', isActive: true },
    { key: '18:00', label: '18-19h', startMinute: 1080, endMinute: 1140, kind: 'overtime', isActive: true },
] as const;

export const serializeProductionLine = (input: any) => {
    const item = typeof input?.toObject === 'function' ? input.toObject() : input;
    return {
        id: toId(item),
        plantId: toId(item.plantId),
        code: item.code,
        name: item.name,
        leaderName: item.leaderName,
        sortOrder: item.sortOrder ?? 0,
        isActive: item.isActive !== false,
        createdAt: toIso(item.createdAt),
        updatedAt: toIso(item.updatedAt),
    };
};

export const serializeProductionItem = (input: any) => {
    const item = typeof input?.toObject === 'function' ? input.toObject() : input;
    return {
        id: toId(item),
        plantId: toId(item.plantId),
        code: item.code,
        name: item.name,
        unit: item.unit || 'SP',
        unitPrice: Number(item.unitPrice || 0),
        operationTemplates: (item.operationTemplates || [])
            .map((template: any) => ({
                operationId: toId(template.operationId),
                operationCode: template.operationCode,
                operationName: template.operationName,
                unit: template.unit || 'SP',
                hourlyQuota: Number(template.hourlyQuota || 0),
                required: template.required !== false,
                sortOrder: Number(template.sortOrder || 0),
            }))
            .sort(
                (left: any, right: any) =>
                    left.sortOrder - right.sortOrder || left.operationCode.localeCompare(right.operationCode)
            ),
        isActive: item.isActive !== false,
        createdAt: toIso(item.createdAt),
        updatedAt: toIso(item.updatedAt),
    };
};

export const serializeProductionOperation = (input: any) => {
    const operation = typeof input?.toObject === 'function' ? input.toObject() : input;
    return {
        id: toId(operation),
        plantId: toId(operation.plantId),
        code: operation.code,
        name: operation.name,
        unit: operation.unit || 'SP',
        sortOrder: Number(operation.sortOrder || 0),
        isActive: operation.isActive !== false,
        createdAt: toIso(operation.createdAt),
        updatedAt: toIso(operation.updatedAt),
    };
};

const slotIndexMap = (slots: any[]) => new Map(slots.map((slot, index) => [String(slot.key), index]));

export const findProductionRunStartConflicts = (entries: any[], startedSlotKey: string, slots: any[]) => {
    const indexByKey = slotIndexMap(slots);
    const startedSlotIndex = indexByKey.get(String(startedSlotKey));
    if (startedSlotIndex === undefined) return [];

    return [
        ...new Set(
            entries
                .map((entry) => String(entry.slotKey))
                .filter((slotKey) => {
                    const entrySlotIndex = indexByKey.get(slotKey);
                    return entrySlotIndex !== undefined && entrySlotIndex >= startedSlotIndex;
                })
        ),
    ].sort((left, right) => Number(indexByKey.get(left)) - Number(indexByKey.get(right)));
};

export const resolveRunForSlot = (runs: any[], slotKey: string, slots: any[]) => {
    const indexByKey = slotIndexMap(slots);
    const slotIndex = indexByKey.get(slotKey);
    if (slotIndex === undefined) return undefined;

    return [...runs]
        .filter((run) => {
            const startIndex = indexByKey.get(String(run.startedSlotKey));
            const endIndex = run.endedSlotKey ? indexByKey.get(String(run.endedSlotKey)) : undefined;
            if (startIndex === undefined || startIndex > slotIndex) return false;
            return endIndex === undefined || slotIndex <= endIndex;
        })
        .sort((left, right) => {
            const leftIndex = indexByKey.get(String(left.startedSlotKey)) ?? -1;
            const rightIndex = indexByKey.get(String(right.startedSlotKey)) ?? -1;
            if (rightIndex !== leftIndex) return rightIndex - leftIndex;
            return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
        })[0];
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

type WholeUnitTargetSegment = {
    key: string;
    groupKey?: string;
    exactTarget: number;
};

/**
 * Phân khoán lẻ vào các khung theo lũy kế để mỗi ô luôn là số sản phẩm nguyên.
 * Ví dụ 15 SP/giờ qua hai khung 30 phút sẽ thành 7 + 8, không phải 7,5 + 7,5
 * hoặc 8 + 8. Mỗi group (run/công đoạn) được cân độc lập và giữ tổng đã làm tròn.
 */
export const allocateWholeUnitTargets = (segments: WholeUnitTargetSegment[]) => {
    const targets = new Map(segments.map((segment) => [segment.key, 0]));
    const groups = new Map<string, WholeUnitTargetSegment[]>();

    segments.forEach((segment) => {
        const exactTarget = Math.max(0, Number(segment.exactTarget || 0));
        if (!segment.groupKey || exactTarget <= 0) return;
        const current = groups.get(segment.groupKey) || [];
        current.push({ ...segment, exactTarget });
        groups.set(segment.groupKey, current);
    });

    groups.forEach((group) => {
        const roundedTotal = Math.round(group.reduce((sum, segment) => sum + segment.exactTarget, 0));
        let cumulativeExact = 0;
        let cumulativeAllocated = 0;

        group.forEach((segment, index) => {
            cumulativeExact += segment.exactTarget;
            const nextAllocated = index === group.length - 1 ? roundedTotal : Math.floor(cumulativeExact + 1e-9);
            targets.set(segment.key, Math.max(0, nextAllocated - cumulativeAllocated));
            cumulativeAllocated = nextAllocated;
        });
    });

    return targets;
};

type ProductionEntrySyncInput = {
    clientMutationId?: string;
    expectedUpdatedAt?: string | null;
    hasExpectedUpdatedAt: boolean;
};

type ProductionEntrySyncDecision =
    | { action: 'write' }
    | { action: 'idempotent' }
    | { action: 'conflict'; reason: 'created-remotely' | 'updated-remotely' | 'deleted-remotely' };

/**
 * Quyết định đồng bộ cho một ô sản lượng. Client cũ không gửi
 * expectedUpdatedAt vẫn được phép ghi như trước; Leader Workspace mới luôn
 * gửi field này để retry offline không âm thầm đè dữ liệu từ thiết bị khác.
 */
export const decideProductionEntrySync = (
    existing: { updatedAt?: Date | string; lastClientMutationId?: string } | null | undefined,
    input: ProductionEntrySyncInput
): ProductionEntrySyncDecision => {
    if (existing && input.clientMutationId && existing.lastClientMutationId === input.clientMutationId) {
        return { action: 'idempotent' };
    }

    if (!input.hasExpectedUpdatedAt) return { action: 'write' };

    if (!existing) {
        return input.expectedUpdatedAt ? { action: 'conflict', reason: 'deleted-remotely' } : { action: 'write' };
    }

    if (!input.expectedUpdatedAt) return { action: 'conflict', reason: 'created-remotely' };

    const current = new Date(existing.updatedAt || 0).getTime();
    const expected = new Date(input.expectedUpdatedAt).getTime();
    return current === expected ? { action: 'write' } : { action: 'conflict', reason: 'updated-remotely' };
};

export const buildProductionDayDetail = (dayInput: any, recordInputs: any[], qcRecordInputs: any[] = []) => {
    const day = typeof dayInput?.toObject === 'function' ? dayInput.toObject() : dayInput;
    const slots = [...(day.timeSlots || [])].sort(
        (left: any, right: any) => Number(left.startMinute || 0) - Number(right.startMinute || 0)
    );
    const qcRecordsByLine = new Map<string, any[]>();
    qcRecordInputs.forEach((input) => {
        const record = typeof input?.toObject === 'function' ? input.toObject() : input;
        const key = String(toId(record.lineId) || '');
        const current = qcRecordsByLine.get(key) || [];
        current.push(record);
        qcRecordsByLine.set(key, current);
    });

    const lines = recordInputs
        .map((input) => {
            const record = typeof input?.toObject === 'function' ? input.toObject() : input;
            const runs = (record.runs || []).map((run: any) => ({
                id: toId(run),
                itemId: toId(run.itemId),
                itemCode: run.itemCode,
                itemName: run.itemName,
                unit: run.unit || 'SP',
                unitPriceSnapshot: Number(run.unitPriceSnapshot || 0),
                hourlyQuota: Number(run.hourlyQuota || 0),
                startedSlotKey: run.startedSlotKey,
                endedSlotKey: run.endedSlotKey,
                plannedEndSlotKey: run.plannedEndSlotKey,
                status: run.status || 'active',
                source: run.source || 'manual',
                planAllocationId: toId(run.planAllocationId),
                plannedQuantity: run.plannedQuantity === undefined ? undefined : Number(run.plannedQuantity),
                orderCode: run.orderCode,
                priority: run.priority || 'normal',
                dueDate: run.dueDate,
                createdAt: toIso(run.createdAt),
                createdBy: toId(run.createdBy),
                createdByName: actorName(run.createdBy),
            }));
            const runById = new Map(runs.map((run: any) => [String(run.id), run]));
            const entries = (record.entries || []).map((entry: any) => {
                const run: any = runById.get(String(entry.runId));
                const quantity = Number(entry.quantity || 0);
                return {
                    id: toId(entry),
                    slotKey: entry.slotKey,
                    runId: toId(entry.runId),
                    quantity,
                    note: entry.note,
                    amount: round(quantity * Number(run?.unitPriceSnapshot || 0), 0),
                    enteredBy: toId(entry.enteredBy),
                    enteredByName: actorName(entry.enteredBy),
                    enteredAt: toIso(entry.enteredAt),
                    updatedBy: toId(entry.updatedBy),
                    updatedByName: actorName(entry.updatedBy),
                    updatedAt: toIso(entry.updatedAt),
                };
            });
            const legacyQcEntries = (record.qcEntries || []).map((entry: any) => {
                const passedQuantity = Number(entry.passedQuantity || 0);
                const defectQuantity = Number(entry.defectQuantity || 0);
                // Không tin total lưu từ client/bản cũ; tổng QC luôn được suy ra
                // từ hai số liệu gốc để báo cáo không thể lệch.
                const totalQuantity = passedQuantity + defectQuantity;
                return {
                    id: toId(entry),
                    slotKey: entry.slotKey,
                    runId: toId(entry.runId) || undefined,
                    inspectionType: 'first_pass',
                    allocationState: 'unallocated',
                    legacy: true,
                    passedQuantity,
                    defectQuantity,
                    totalQuantity,
                    defectRate: totalQuantity > 0 ? round((defectQuantity / totalQuantity) * 100, 2) : 0,
                    note: entry.note,
                    enteredBy: toId(entry.enteredBy),
                    enteredByName: actorName(entry.enteredBy),
                    enteredAt: toIso(entry.enteredAt),
                    updatedBy: toId(entry.updatedBy),
                    updatedByName: actorName(entry.updatedBy),
                    updatedAt: toIso(entry.updatedAt),
                };
            });
            const qcSlotRecords = (qcRecordsByLine.get(String(toId(record.lineId) || '')) || [])
                .map((qcRecord: any) => {
                    const inspections = (qcRecord.inspections || []).map((entry: any) => {
                        const passedQuantity = Number(entry.passedQuantity || 0);
                        const defectQuantity = Number(entry.defectQuantity || 0);
                        const totalQuantity = passedQuantity + defectQuantity;
                        return {
                            id: toId(entry),
                            itemId: toId(entry.itemId),
                            itemCode: entry.itemCode,
                            itemName: entry.itemName,
                            unit: entry.unit || 'SP',
                            orderCode: entry.orderCode,
                            inspectionType: entry.inspectionType || 'first_pass',
                            sourceType: entry.sourceType || 'current_day',
                            sourceProductionDate: entry.sourceProductionDate,
                            passedQuantity,
                            defectQuantity,
                            totalQuantity,
                            defectRate: totalQuantity > 0 ? round((defectQuantity / totalQuantity) * 100, 2) : 0,
                            note: entry.note,
                        };
                    });
                    const passedQuantity = inspections.reduce(
                        (sum: number, entry: any) => sum + entry.passedQuantity,
                        0
                    );
                    const defectQuantity = inspections.reduce(
                        (sum: number, entry: any) => sum + entry.defectQuantity,
                        0
                    );
                    return {
                        id: toId(qcRecord),
                        dayId: toId(qcRecord.dayId),
                        lineId: toId(qcRecord.lineId),
                        slotKey: qcRecord.slotKey,
                        inspections,
                        passedQuantity,
                        defectQuantity,
                        totalQuantity: passedQuantity + defectQuantity,
                        enteredBy: toId(qcRecord.enteredBy),
                        enteredByName: actorName(qcRecord.enteredBy),
                        enteredAt: toIso(qcRecord.enteredAt),
                        updatedBy: toId(qcRecord.updatedBy),
                        updatedByName: actorName(qcRecord.updatedBy),
                        updatedAt: toIso(qcRecord.updatedAt),
                    };
                })
                .sort((left: any, right: any) => String(left.slotKey).localeCompare(String(right.slotKey)));
            const structuredSlots = new Set(qcSlotRecords.map((item: any) => String(item.slotKey)));
            // Một record QC mới thay thế dữ liệu legacy trong đúng ô giờ đó. Các
            // ô cũ chưa được phân bổ vẫn giữ nguyên và được đánh dấu rõ ràng.
            const qcEntries = [
                ...legacyQcEntries.filter((entry: any) => !structuredSlots.has(String(entry.slotKey))),
                ...qcSlotRecords.flatMap((qcRecord: any) =>
                    qcRecord.inspections.map((entry: any) => ({
                        ...entry,
                        id: `${qcRecord.id}:${entry.id}`,
                        recordId: qcRecord.id,
                        slotKey: qcRecord.slotKey,
                        allocationState: 'exact',
                        legacy: false,
                        enteredBy: qcRecord.enteredBy,
                        enteredByName: qcRecord.enteredByName,
                        enteredAt: qcRecord.enteredAt,
                        updatedBy: qcRecord.updatedBy,
                        updatedByName: qcRecord.updatedByName,
                        updatedAt: qcRecord.updatedAt,
                    }))
                ),
            ];
            const operationTracks = (record.operationTracks || [])
                .map((track: any) => ({
                    id: toId(track),
                    operationId: toId(track.operationId),
                    operationCode: track.operationCode,
                    operationName: track.operationName,
                    unit: track.unit || 'SP',
                    itemId: toId(track.itemId),
                    itemCode: track.itemCode,
                    sourceRunId: toId(track.sourceRunId),
                    hourlyQuota: Number(track.hourlyQuota || 0),
                    required: track.required !== false,
                    sortOrder: Number(track.sortOrder || 0),
                    startedSlotKey: track.startedSlotKey,
                    endedSlotKey: track.endedSlotKey,
                    status: track.status || 'active',
                    createdBy: toId(track.createdBy),
                    createdByName: actorName(track.createdBy),
                    createdAt: toIso(track.createdAt),
                }))
                .sort(
                    (left: any, right: any) =>
                        left.sortOrder - right.sortOrder || left.operationCode.localeCompare(right.operationCode)
                );
            const operationEntries = (record.operationEntries || []).map((entry: any) => ({
                id: toId(entry),
                slotKey: entry.slotKey,
                trackId: toId(entry.trackId),
                quantity: Number(entry.quantity || 0),
                note: entry.note,
                enteredBy: toId(entry.enteredBy),
                enteredByName: actorName(entry.enteredBy),
                enteredAt: toIso(entry.enteredAt),
                updatedBy: toId(entry.updatedBy),
                updatedByName: actorName(entry.updatedBy),
                updatedAt: toIso(entry.updatedAt),
            }));
            const slotIndexByKey = new Map(slots.map((slot: any, index: number) => [String(slot.key), index]));
            const operationTargetByKey = allocateWholeUnitTargets(
                operationTracks.flatMap((track: any) => {
                    const startIndex = Number(
                        slotIndexByKey.get(String(track.startedSlotKey)) ?? Number.MAX_SAFE_INTEGER
                    );
                    const endIndex = track.endedSlotKey
                        ? Number(slotIndexByKey.get(String(track.endedSlotKey)) ?? -1)
                        : Number.MAX_SAFE_INTEGER;
                    return slots.map((slot: any, slotIndex: number) => {
                        const due = slot.isActive !== false && slotIndex >= startIndex && slotIndex <= endIndex;
                        const durationHours = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)) / 60;
                        return {
                            key: `${track.id}:${slot.key}`,
                            groupKey: String(track.id),
                            exactTarget:
                                due && slot.kind !== 'overtime' ? Number(track.hourlyQuota || 0) * durationHours : 0,
                        };
                    });
                })
            );
            const operationSlotValues = operationTracks.flatMap((track: any) => {
                const startIndex = Number(slotIndexByKey.get(String(track.startedSlotKey)) ?? Number.MAX_SAFE_INTEGER);
                const endIndex = track.endedSlotKey
                    ? Number(slotIndexByKey.get(String(track.endedSlotKey)) ?? -1)
                    : Number.MAX_SAFE_INTEGER;
                return slots.map((slot: any, slotIndex: number) => {
                    const slotEntries = operationEntries.filter(
                        (entry: any) => entry.slotKey === slot.key && String(entry.trackId) === String(track.id)
                    );
                    const latestEntry = [...slotEntries].sort(
                        (left: any, right: any) =>
                            new Date(right.updatedAt || right.enteredAt || 0).getTime() -
                            new Date(left.updatedAt || left.enteredAt || 0).getTime()
                    )[0];
                    const due = slot.isActive !== false && slotIndex >= startIndex && slotIndex <= endIndex;
                    const target = operationTargetByKey.get(`${track.id}:${slot.key}`) || 0;
                    const actual = slotEntries.reduce(
                        (sum: number, entry: any) => sum + Number(entry.quantity || 0),
                        0
                    );
                    return {
                        key: slot.key,
                        trackId: track.id,
                        operationId: track.operationId,
                        operationCode: track.operationCode,
                        operationName: track.operationName,
                        unit: track.unit,
                        itemId: track.itemId,
                        itemCode: track.itemCode,
                        sourceRunId: track.sourceRunId,
                        required: track.required,
                        due,
                        transition: !due && slotEntries.length > 0,
                        overtime: slot.kind === 'overtime',
                        target,
                        actual,
                        achievementPercent: target > 0 ? round((actual / target) * 100, 1) : 0,
                        reported: slotEntries.length > 0,
                        entryIds: slotEntries.map((entry: any) => entry.id),
                        note:
                            [...new Set(slotEntries.map((entry: any) => entry.note).filter(Boolean))]
                                .join(' · ')
                                .slice(0, 500) || undefined,
                        enteredBy: latestEntry?.enteredBy,
                        enteredByName: latestEntry?.enteredByName,
                        enteredAt: latestEntry?.enteredAt,
                        updatedBy: latestEntry?.updatedBy,
                        updatedByName: latestEntry?.updatedByName,
                        updatedAt: latestEntry?.updatedAt,
                    };
                });
            });
            const operationTrackSummaries = operationTracks.map((track: any) => {
                const values = operationSlotValues.filter((value: any) => value.trackId === track.id);
                const dueValues = values.filter((value: any) => value.due);
                const target = dueValues.reduce((sum: number, value: any) => sum + Number(value.target || 0), 0);
                const actual = values.reduce((sum: number, value: any) => sum + Number(value.actual || 0), 0);
                const expectedEntries = track.required ? dueValues.length : 0;
                const reportedEntries = track.required
                    ? dueValues.filter((value: any) => value.reported).length
                    : values.filter((value: any) => value.reported).length;
                return {
                    ...track,
                    target: round(target),
                    actual,
                    achievementPercent: target > 0 ? round((actual / target) * 100, 1) : 0,
                    expectedEntries,
                    reportedEntries,
                    coveragePercent: expectedEntries > 0 ? round((reportedEntries / expectedEntries) * 100, 1) : 100,
                };
            });

            const productionSlotContexts = slots.map((slot: any) => {
                // Slot đã tắt không được mang runId: API nhập liệu từ chối slot tắt, nên nếu vẫn gán
                // runId thì validate gửi duyệt + báo cáo sẽ đòi số liệu ở ô không bao giờ nhập được.
                const slotEntries = entries.filter((entry: any) => entry.slotKey === slot.key);
                const scheduledRun =
                    slot.isActive === false ? undefined : resolveRunForSlot(runs, String(slot.key), slots);
                const entryRunIds = [...new Set(slotEntries.map((entry: any) => String(entry.runId)))];
                // Bản ghi sản lượng là bằng chứng lịch sử mạnh hơn khoảng run hiện tại. Điều này giữ đúng
                // mã hàng, đơn giá và khoán nếu một lần đổi mã cũ đã vô tình áp dụng ngược vào giờ đã báo.
                const recordedRun = entryRunIds.length === 1 ? runById.get(entryRunIds[0]) : undefined;
                const run = slot.isActive === false ? undefined : recordedRun || scheduledRun;
                const durationHours = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)) / 60;
                // Tăng ca KHÔNG nâng khoán: KPI ngày chốt trên giờ hành chính (10 giờ x 200 = 2000),
                // làm thêm 1-2 tiếng thì sản lượng đó là phần vượt để xét thưởng, không phải chỉ tiêu.
                const overtime = slot.kind === 'overtime';
                return {
                    slot,
                    slotEntries,
                    run,
                    overtime,
                    exactTarget: overtime ? 0 : Number(run?.hourlyQuota || 0) * durationHours,
                };
            });
            const productionTargetBySlot = allocateWholeUnitTargets(
                productionSlotContexts.map(({ slot, run, exactTarget }: any) => ({
                    key: String(slot.key),
                    groupKey: run?.id ? String(run.id) : undefined,
                    exactTarget,
                }))
            );
            const slotValues = productionSlotContexts.map(({ slot, slotEntries, run, overtime }: any) => ({
                key: slot.key,
                overtime,
                target: productionTargetBySlot.get(String(slot.key)) || 0,
                actual: slotEntries.reduce((sum: number, entry: any) => sum + entry.quantity, 0),
                reported: slotEntries.length > 0,
                runId: run?.id,
                entryIds: slotEntries.map((entry: any) => entry.id),
            }));
            const productionSlotByKey = new Map(slotValues.map((value: any) => [String(value.key), value]));
            const qcSlotValues = slots.map((slot: any) => {
                const slotEntries = qcEntries.filter((entry: any) => entry.slotKey === slot.key);
                const productionSlot: any = productionSlotByKey.get(String(slot.key));
                const scheduledRun =
                    slot.isActive === false ? undefined : resolveRunForSlot(runs, String(slot.key), slots);
                const referenceRun =
                    slot.isActive === false ? undefined : runById.get(productionSlot?.runId) || scheduledRun;
                const passedQuantity = slotEntries.reduce(
                    (sum: number, entry: any) => sum + Number(entry.passedQuantity || 0),
                    0
                );
                const defectQuantity = slotEntries.reduce(
                    (sum: number, entry: any) => sum + Number(entry.defectQuantity || 0),
                    0
                );
                const totalQuantity = passedQuantity + defectQuantity;
                const firstPassQuantity = slotEntries
                    .filter((entry: any) => entry.inspectionType !== 'recheck')
                    .reduce((sum: number, entry: any) => sum + Number(entry.totalQuantity || 0), 0);
                const recheckQuantity = slotEntries
                    .filter((entry: any) => entry.inspectionType === 'recheck')
                    .reduce((sum: number, entry: any) => sum + Number(entry.totalQuantity || 0), 0);
                const unallocatedQuantity = slotEntries
                    .filter((entry: any) => entry.allocationState === 'unallocated')
                    .reduce((sum: number, entry: any) => sum + Number(entry.totalQuantity || 0), 0);
                const latestEntry = [...slotEntries].sort(
                    (left: any, right: any) =>
                        new Date(right.updatedAt || right.enteredAt || 0).getTime() -
                        new Date(left.updatedAt || left.enteredAt || 0).getTime()
                )[0];
                const notes = [...new Set(slotEntries.map((entry: any) => entry.note).filter(Boolean))];
                const productionActualReference = Number(productionSlot?.actual || 0);
                return {
                    key: slot.key,
                    overtime: slot.kind === 'overtime',
                    passedQuantity,
                    defectQuantity,
                    totalQuantity,
                    defectRate: totalQuantity > 0 ? round((defectQuantity / totalQuantity) * 100, 2) : 0,
                    firstPassQuantity,
                    recheckQuantity,
                    unallocatedQuantity,
                    productionActualReference,
                    // Các field dưới giữ tạm một phiên bản để FE cũ không vỡ
                    // trong lúc rollout. Không còn được dùng làm KPI QC.
                    productionActual: productionActualReference,
                    varianceQuantity: 0,
                    pendingQuantity: 0,
                    reported: slotEntries.length > 0,
                    referenceRunId: referenceRun?.id,
                    runId: referenceRun?.id,
                    entryIds: slotEntries.map((entry: any) => entry.id),
                    note: notes.join(' · ').slice(0, 500) || undefined,
                    enteredBy: latestEntry?.enteredBy,
                    enteredByName: latestEntry?.enteredByName,
                    enteredAt: latestEntry?.enteredAt,
                    updatedBy: latestEntry?.updatedBy,
                    updatedByName: latestEntry?.updatedByName,
                    updatedAt: latestEntry?.updatedAt,
                };
            });

            const totalTarget = slotValues.reduce((sum: number, slot: any) => sum + slot.target, 0);
            const totalActual = entries.reduce((sum: number, entry: any) => sum + entry.quantity, 0);
            const totalAmount = entries.reduce((sum: number, entry: any) => sum + entry.amount, 0);
            const qcPassedQuantity = qcEntries.reduce(
                (sum: number, entry: any) => sum + Number(entry.passedQuantity || 0),
                0
            );
            const qcDefectQuantity = qcEntries.reduce(
                (sum: number, entry: any) => sum + Number(entry.defectQuantity || 0),
                0
            );
            const qcTotalQuantity = qcEntries.reduce(
                (sum: number, entry: any) =>
                    sum + Number(entry.passedQuantity || 0) + Number(entry.defectQuantity || 0),
                0
            );
            const qcFirstPassQuantity = qcEntries
                .filter((entry: any) => entry.inspectionType !== 'recheck')
                .reduce((sum: number, entry: any) => sum + Number(entry.totalQuantity || 0), 0);
            const qcRecheckQuantity = qcEntries
                .filter((entry: any) => entry.inspectionType === 'recheck')
                .reduce((sum: number, entry: any) => sum + Number(entry.totalQuantity || 0), 0);
            const qcUnallocatedQuantity = qcEntries
                .filter((entry: any) => entry.allocationState === 'unallocated')
                .reduce((sum: number, entry: any) => sum + Number(entry.totalQuantity || 0), 0);
            const qcExpectedSlots = slots.filter((slot: any) => slot.isActive !== false).length;
            const qcReportedSlots = qcSlotValues.filter(
                (value: any, index: number) => slots[index]?.isActive !== false && value.reported
            ).length;
            const operationExpectedEntries = operationTrackSummaries.reduce(
                (sum: number, track: any) => sum + Number(track.expectedEntries || 0),
                0
            );
            const operationReportedEntries = operationTrackSummaries.reduce(
                (sum: number, track: any) => sum + Number(track.reportedEntries || 0),
                0
            );
            const workerCount = Number(record.workerCount || 0);

            return {
                id: toId(record),
                dayId: toId(record.dayId),
                plantId: toId(record.plantId),
                productionDate: record.productionDate,
                lineId: toId(record.lineId),
                lineCode: record.lineCode,
                lineName: record.lineName,
                leaderName: record.leaderName,
                sortOrder: Number(record.sortOrder || 0),
                workerCount,
                workerCountConfirmed: Boolean(record.workerCountConfirmedAt),
                workerCountConfirmedAt: toIso(record.workerCountConfirmedAt),
                workerCountConfirmedBy: toId(record.workerCountConfirmedBy),
                workerCountConfirmedByName: actorName(record.workerCountConfirmedBy),
                runs,
                entries,
                slotValues,
                qcEntries,
                qcSlotRecords,
                qcSlotValues,
                operationTrackingEnabled: Boolean(record.operationTrackingEnabled),
                operationTracks,
                operationEntries,
                operationSlotValues,
                operationTrackSummaries,
                totalTarget: round(totalTarget),
                totalActual,
                achievementPercent: totalTarget > 0 ? round((totalActual / totalTarget) * 100, 1) : 0,
                totalAmount: round(totalAmount, 0),
                averageIncome: workerCount > 0 ? round(totalAmount / workerCount, 0) : 0,
                qcPassedQuantity,
                qcDefectQuantity,
                qcTotalQuantity,
                qcFirstPassQuantity,
                qcRecheckQuantity,
                qcUnallocatedQuantity,
                qcDefectRate: qcTotalQuantity > 0 ? round((qcDefectQuantity / qcTotalQuantity) * 100, 2) : 0,
                qcPendingQuantity: 0,
                qcReportedSlots,
                qcExpectedSlots,
                qcCoveragePercent: qcExpectedSlots > 0 ? round((qcReportedSlots / qcExpectedSlots) * 100, 1) : 0,
                operationExpectedEntries,
                operationReportedEntries,
                operationCoveragePercent:
                    operationExpectedEntries > 0
                        ? round((operationReportedEntries / operationExpectedEntries) * 100, 1)
                        : 100,
                operationBehindCount: operationTrackSummaries.filter(
                    (track: any) => track.target > 0 && track.actual < track.target
                ).length,
                configured: Boolean(record.workerCountConfirmedAt && runs.length > 0),
                updatedBy: toId(record.updatedBy),
                updatedByName: actorName(record.updatedBy),
                updatedAt: [toIso(record.updatedAt), ...qcSlotRecords.map((item: any) => item.updatedAt)]
                    .filter(Boolean)
                    .sort()
                    .at(-1),
            };
        })
        .sort((left, right) => left.sortOrder - right.sortOrder || left.lineCode.localeCompare(right.lineCode));

    const slotSummaries = slots.map((slot: any) => {
        const values = lines.map((line: any) => line.slotValues.find((value: any) => value.key === slot.key));
        const qcValues = lines.map((line: any) => line.qcSlotValues.find((value: any) => value.key === slot.key));
        const operationValues = lines.flatMap((line: any) =>
            line.operationSlotValues.filter((value: any) => value.key === slot.key && value.due && value.required)
        );
        // Mẫu số chỉ tính chuyền CÓ mã chạy trong khung giờ này — khớp logic validate gửi duyệt,
        // tránh khung chiều báo "3/12 chuyền" khi 9 chuyền đã kết thúc allocation từ trưa.
        const dueLines = lines.filter(
            (line: any) =>
                line.configured && line.slotValues.some((value: any) => value.key === slot.key && value.runId)
        );
        const qcReportedLines = lines.filter((line: any) =>
            line.qcSlotValues.some((value: any) => value.key === slot.key && value.reported)
        ).length;
        return {
            key: slot.key,
            overtime: slot.kind === 'overtime',
            target: round(values.reduce((sum: number, value: any) => sum + Number(value?.target || 0), 0)),
            actual: values.reduce((sum: number, value: any) => sum + Number(value?.actual || 0), 0),
            reportedLines: dueLines.filter((line: any) =>
                line.slotValues.some((value: any) => value.key === slot.key && value.reported)
            ).length,
            qcPassedQuantity: qcValues.reduce((sum: number, value: any) => sum + Number(value?.passedQuantity || 0), 0),
            qcDefectQuantity: qcValues.reduce((sum: number, value: any) => sum + Number(value?.defectQuantity || 0), 0),
            qcTotalQuantity: qcValues.reduce((sum: number, value: any) => sum + Number(value?.totalQuantity || 0), 0),
            qcReportedLines,
            qcExpectedLines: slot.isActive === false ? 0 : lines.length,
            qcCoveragePercent:
                slot.isActive === false || !lines.length ? 0 : round((qcReportedLines / lines.length) * 100, 1),
            operationExpectedEntries: operationValues.length,
            operationReportedEntries: operationValues.filter((value: any) => value.reported).length,
            operationCoveragePercent:
                operationValues.length > 0
                    ? round(
                          (operationValues.filter((value: any) => value.reported).length / operationValues.length) *
                              100,
                          1
                      )
                    : 100,
            operationBehindCount: operationValues.filter(
                (value: any) => value.reported && value.target > 0 && value.actual < value.target
            ).length,
            totalLines: dueLines.length,
        };
    });

    const totalTarget = lines.reduce((sum, line) => sum + line.totalTarget, 0);
    const totalActual = lines.reduce((sum, line) => sum + line.totalActual, 0);
    const totalAmount = lines.reduce((sum, line) => sum + line.totalAmount, 0);
    const totalWorkers = lines.reduce((sum, line) => sum + line.workerCount, 0);
    const qcPassedQuantity = lines.reduce((sum, line) => sum + line.qcPassedQuantity, 0);
    const qcDefectQuantity = lines.reduce((sum, line) => sum + line.qcDefectQuantity, 0);
    const qcTotalQuantity = lines.reduce((sum, line) => sum + line.qcTotalQuantity, 0);
    const qcFirstPassQuantity = lines.reduce((sum, line) => sum + Number(line.qcFirstPassQuantity || 0), 0);
    const qcRecheckQuantity = lines.reduce((sum, line) => sum + Number(line.qcRecheckQuantity || 0), 0);
    const qcUnallocatedQuantity = lines.reduce((sum, line) => sum + Number(line.qcUnallocatedQuantity || 0), 0);
    const qcReportedLineSlots = lines.reduce((sum, line) => sum + Number(line.qcReportedSlots || 0), 0);
    const qcExpectedLineSlots = lines.reduce((sum, line) => sum + Number(line.qcExpectedSlots || 0), 0);
    const operationExpectedEntries = lines.reduce((sum, line) => sum + Number(line.operationExpectedEntries || 0), 0);
    const operationReportedEntries = lines.reduce((sum, line) => sum + Number(line.operationReportedEntries || 0), 0);
    const operationTrackCount = lines.reduce((sum, line) => sum + Number(line.operationTracks?.length || 0), 0);

    const dataAsOf = [day.updatedAt, ...lines.map((line: any) => line.updatedAt)]
        .filter(Boolean)
        .map((value) => new Date(value).getTime())
        .filter(Number.isFinite)
        .reduce((latest, value) => Math.max(latest, value), 0);

    return {
        id: toId(day),
        plantId: toId(day.plantId),
        plantName: day.plantName,
        plantCode: day.plantCode,
        productionDate: day.productionDate,
        status: day.status || 'draft',
        reportingState: day.status === 'locked' ? 'official' : 'provisional',
        dataAsOf: dataAsOf > 0 ? new Date(dataAsOf).toISOString() : undefined,
        statusNote: day.statusNote,
        submittedAt: toIso(day.submittedAt),
        submittedBy: serializeActor(day.submittedBy),
        lockedAt: toIso(day.lockedAt),
        lockedBy: serializeActor(day.lockedBy),
        reopenedAt: toIso(day.reopenedAt),
        reopenedBy: serializeActor(day.reopenedBy),
        statusHistory: (day.statusHistory || []).map((event: any) => ({
            id: toId(event),
            from: event.from,
            to: event.to,
            note: event.note,
            actor: serializeActor(event.actor),
            at: toIso(event.at),
        })),
        timeSlots: slots.map((slot: any) => ({
            key: slot.key,
            label: slot.label,
            startMinute: Number(slot.startMinute),
            endMinute: Number(slot.endMinute),
            kind: slot.kind || 'regular',
            isActive: slot.isActive !== false,
        })),
        lines,
        summary: {
            lineCount: lines.length,
            configuredLineCount: lines.filter((line) => line.configured).length,
            totalWorkers,
            totalTarget: round(totalTarget),
            totalActual,
            achievementPercent: totalTarget > 0 ? round((totalActual / totalTarget) * 100, 1) : 0,
            totalAmount: round(totalAmount, 0),
            averageIncome: totalWorkers > 0 ? round(totalAmount / totalWorkers, 0) : 0,
            itemCount: new Set(lines.flatMap((line) => line.runs.map((run: any) => run.itemId))).size,
            qcPassedQuantity,
            qcDefectQuantity,
            qcTotalQuantity,
            qcFirstPassQuantity,
            qcRecheckQuantity,
            qcUnallocatedQuantity,
            qcDefectRate: qcTotalQuantity > 0 ? round((qcDefectQuantity / qcTotalQuantity) * 100, 2) : 0,
            qcPendingQuantity: 0,
            qcReportedLineSlots,
            qcExpectedLineSlots,
            qcCoveragePercent:
                qcExpectedLineSlots > 0 ? round((qcReportedLineSlots / qcExpectedLineSlots) * 100, 1) : 0,
            operationTrackedLineCount: lines.filter((line) => line.operationTrackingEnabled).length,
            operationTrackCount,
            operationExpectedEntries,
            operationReportedEntries,
            operationCoveragePercent:
                operationExpectedEntries > 0
                    ? round((operationReportedEntries / operationExpectedEntries) * 100, 1)
                    : 100,
            operationBehindCount: lines.reduce((sum, line) => sum + Number(line.operationBehindCount || 0), 0),
        },
        slotSummaries,
        createdAt: toIso(day.createdAt),
        updatedAt: toIso(day.updatedAt),
    };
};

export const validateProductionDayForSubmission = (detail: any) => {
    const configuredLines = detail.lines.filter((line: any) => line.configured);
    if (!configuredLines.length) {
        return { valid: false, message: 'Chưa có chuyền nào được xác nhận nhân sự và mã hàng' };
    }

    const entryCount = configuredLines.reduce((total: number, line: any) => total + line.entries.length, 0);
    if (!entryCount) {
        return { valid: false, message: 'Ngày sản xuất chưa có số liệu theo giờ' };
    }

    const slotLabels = new Map(detail.timeSlots.map((slot: any) => [slot.key, slot.label]));
    const missing = configuredLines.flatMap((line: any) =>
        line.slotValues
            .filter((slot: any) => slot.runId && !slot.reported)
            .map((slot: any) => `${line.lineCode} - ${slotLabels.get(slot.key) || slot.key}`)
    );
    if (missing.length) {
        const preview = missing.slice(0, 5).join(', ');
        const suffix = missing.length > 5 ? ` và ${missing.length - 5} ô khác` : '';
        return { valid: false, message: `Còn thiếu sản lượng: ${preview}${suffix}` };
    }

    const missingOperations = configuredLines.flatMap((line: any) =>
        (line.operationSlotValues || [])
            .filter((value: any) => value.due && value.required && !value.reported)
            .map(
                (value: any) => `${line.lineCode} - ${value.operationCode} - ${slotLabels.get(value.key) || value.key}`
            )
    );
    if (missingOperations.length) {
        const preview = missingOperations.slice(0, 5).join(', ');
        const suffix = missingOperations.length > 5 ? ` và ${missingOperations.length - 5} ô khác` : '';
        return { valid: false, message: `Còn thiếu công đoạn bắt buộc: ${preview}${suffix}` };
    }

    return { valid: true };
};

export const redactProductionFinancials = (detail: any) => ({
    ...detail,
    financialsVisible: false,
    lines: detail.lines.map((line: any) => ({
        ...line,
        totalAmount: 0,
        averageIncome: 0,
        runs: line.runs.map(({ unitPriceSnapshot: _unitPriceSnapshot, ...run }: any) => run),
        entries: line.entries.map(({ amount: _amount, ...entry }: any) => entry),
    })),
    summary: {
        ...detail.summary,
        totalAmount: 0,
        averageIncome: 0,
    },
});
