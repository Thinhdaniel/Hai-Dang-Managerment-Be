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
        isActive: item.isActive !== false,
        createdAt: toIso(item.createdAt),
        updatedAt: toIso(item.updatedAt),
    };
};

const slotIndexMap = (slots: any[]) => new Map(slots.map((slot, index) => [String(slot.key), index]));

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

export const buildProductionDayDetail = (dayInput: any, recordInputs: any[]) => {
    const day = typeof dayInput?.toObject === 'function' ? dayInput.toObject() : dayInput;
    const slots = [...(day.timeSlots || [])].sort(
        (left: any, right: any) => Number(left.startMinute || 0) - Number(right.startMinute || 0)
    );

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

            const slotValues = slots.map((slot: any) => {
                // Slot đã tắt không được mang runId: API nhập liệu từ chối slot tắt, nên nếu vẫn gán
                // runId thì validate gửi duyệt + báo cáo sẽ đòi số liệu ở ô không bao giờ nhập được.
                const run = slot.isActive === false ? undefined : resolveRunForSlot(runs, String(slot.key), slots);
                const slotEntries = entries.filter((entry: any) => entry.slotKey === slot.key);
                const durationHours = Math.max(0, Number(slot.endMinute) - Number(slot.startMinute)) / 60;
                const target = Number(run?.hourlyQuota || 0) * durationHours;
                return {
                    key: slot.key,
                    target: round(target),
                    actual: slotEntries.reduce((sum: number, entry: any) => sum + entry.quantity, 0),
                    reported: slotEntries.length > 0,
                    runId: run?.id,
                    entryIds: slotEntries.map((entry: any) => entry.id),
                };
            });

            const totalTarget = slotValues.reduce((sum: number, slot: any) => sum + slot.target, 0);
            const totalActual = entries.reduce((sum: number, entry: any) => sum + entry.quantity, 0);
            const totalAmount = entries.reduce((sum: number, entry: any) => sum + entry.amount, 0);
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
                totalTarget: round(totalTarget),
                totalActual,
                achievementPercent: totalTarget > 0 ? round((totalActual / totalTarget) * 100, 1) : 0,
                totalAmount: round(totalAmount, 0),
                averageIncome: workerCount > 0 ? round(totalAmount / workerCount, 0) : 0,
                configured: Boolean(record.workerCountConfirmedAt && runs.length > 0),
                updatedBy: toId(record.updatedBy),
                updatedByName: actorName(record.updatedBy),
                updatedAt: toIso(record.updatedAt),
            };
        })
        .sort((left, right) => left.sortOrder - right.sortOrder || left.lineCode.localeCompare(right.lineCode));

    const slotSummaries = slots.map((slot: any) => {
        const values = lines.map((line: any) => line.slotValues.find((value: any) => value.key === slot.key));
        // Mẫu số chỉ tính chuyền CÓ mã chạy trong khung giờ này — khớp logic validate gửi duyệt,
        // tránh khung chiều báo "3/12 chuyền" khi 9 chuyền đã kết thúc allocation từ trưa.
        const dueLines = lines.filter(
            (line: any) =>
                line.configured && line.slotValues.some((value: any) => value.key === slot.key && value.runId)
        );
        return {
            key: slot.key,
            target: round(values.reduce((sum: number, value: any) => sum + Number(value?.target || 0), 0)),
            actual: values.reduce((sum: number, value: any) => sum + Number(value?.actual || 0), 0),
            reportedLines: dueLines.filter((line: any) =>
                line.slotValues.some((value: any) => value.key === slot.key && value.reported)
            ).length,
            totalLines: dueLines.length,
        };
    });

    const totalTarget = lines.reduce((sum, line) => sum + line.totalTarget, 0);
    const totalActual = lines.reduce((sum, line) => sum + line.totalActual, 0);
    const totalAmount = lines.reduce((sum, line) => sum + line.totalAmount, 0);
    const totalWorkers = lines.reduce((sum, line) => sum + line.workerCount, 0);

    return {
        id: toId(day),
        plantId: toId(day.plantId),
        plantName: day.plantName,
        plantCode: day.plantCode,
        productionDate: day.productionDate,
        status: day.status || 'draft',
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
