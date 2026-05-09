import ReturnRecord from '@/models/ReturnRecord';

export const returnRecordRepository = {
    create: (data: any) => ReturnRecord.create(data),

    findById: (id: string) =>
        ReturnRecord.findOne({ _id: id, isDeleted: { $ne: true } })
            .populate('purchaseOrderId')
            .populate('supplierId')
            .populate('plantId')
            .populate('returnedBy', 'name email'),

    findMany: (filter: any, opts: { sort?: string; skip?: number; limit?: number } = {}) =>
        ReturnRecord.find(filter)
            .sort(opts.sort || '-createdAt')
            .skip(opts.skip || 0)
            .limit(opts.limit || 20)
            .populate('purchaseOrderId', 'orderCode')
            .populate('supplierId', 'name')
            .populate('returnedBy', 'name'),

    countDocuments: (filter: any) => ReturnRecord.countDocuments(filter),
};
