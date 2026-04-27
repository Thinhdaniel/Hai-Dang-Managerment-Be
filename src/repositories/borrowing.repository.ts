import Borrowing from '@/models/Borrowing';
import { applyPopulate, WORKFLOW_POPULATE } from '@/services/service.helpers';

type BorrowingFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
};

export const borrowingRepository = {
    countDocuments(filter: BorrowingFilter) {
        return Borrowing.countDocuments(filter);
    },

    create(data: Record<string, unknown>) {
        return Borrowing.create(data);
    },

    findById(id: string) {
        return applyPopulate(Borrowing.findOne({ _id: id, isDeleted: { $ne: true } }), WORKFLOW_POPULATE.borrowing);
    },

    findByAssetId(assetId: string) {
        return applyPopulate(Borrowing.find({ assetId, isDeleted: { $ne: true } }), WORKFLOW_POPULATE.borrowing).sort({
            borrowTime: -1,
            createdAt: -1,
        });
    },

    findMany(filter: BorrowingFilter, { limit, skip, sort = '-createdAt' }: FindManyOptions = {}) {
        let query = applyPopulate(Borrowing.find(filter), WORKFLOW_POPULATE.borrowing).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        return query;
    },

    findActiveByAssetId(assetId: string) {
        return Borrowing.findOne({
            assetId,
            isDeleted: { $ne: true },
            status: 'active',
        }).sort({ createdAt: -1 });
    },

    updateById(id: string, update: Record<string, unknown>) {
        return applyPopulate(
            Borrowing.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
                new: true,
                runValidators: true,
            }),
            WORKFLOW_POPULATE.borrowing
        );
    },
};
