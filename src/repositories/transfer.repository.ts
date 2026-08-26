import Transfer from '@/models/Transfer';
import { applyPopulate, WORKFLOW_POPULATE } from '@/services/service.helpers';

type TransferFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
};

export const transferRepository = {
    countDocuments(filter: TransferFilter) {
        return Transfer.countDocuments(filter);
    },

    create(data: Record<string, unknown>) {
        return Transfer.create(data);
    },

    findById(id: string) {
        return applyPopulate(Transfer.findOne({ _id: id, isDeleted: { $ne: true } }), WORKFLOW_POPULATE.transfer);
    },

    findByAssetId(assetId: string) {
        return applyPopulate(
            Transfer.find({
                isDeleted: { $ne: true },
                $or: [{ assetId }, { assetIds: assetId }],
            }),
            WORKFLOW_POPULATE.transfer
        ).sort({
            transferDate: -1,
            createdAt: -1,
        });
    },

    findMany(filter: TransferFilter, { limit, skip, sort = '-createdAt' }: FindManyOptions = {}) {
        let query = applyPopulate(Transfer.find(filter), WORKFLOW_POPULATE.transfer).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        return query;
    },

    findOpenByAssetId(assetId: string) {
        return Transfer.findOne({
            isDeleted: { $ne: true },
            status: { $in: ['pending', 'approved'] },
            $or: [{ assetId }, { assetIds: assetId }],
        }).sort({ createdAt: -1 });
    },

    findOpenByAssetIds(assetIds: string[]) {
        return Transfer.find({
            isDeleted: { $ne: true },
            status: { $in: ['pending', 'approved'] },
            $or: [{ assetId: { $in: assetIds } }, { assetIds: { $in: assetIds } }],
        }).sort({ createdAt: -1 });
    },

    updateById(id: string, update: Record<string, unknown>) {
        return applyPopulate(
            Transfer.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
                returnDocument: 'after',
                runValidators: true,
            }),
            WORKFLOW_POPULATE.transfer
        );
    },
};
