import DistributionRecord from '@/models/DistributionRecord';
import type { ClientSession } from 'mongoose';

type DistributionFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
    session?: ClientSession;
};

const buildDistributionQuery = (filter: DistributionFilter) =>
    DistributionRecord.find(filter)
        .populate('fromPlantId')
        .populate('toPlantId')
        .populate('purchaseOrderId')
        .populate('distributedBy')
        .populate('confirmedBy')
        .populate('supplyRequestId')
        .populate('items.materialId');

export const distributionRepository = {
    countDocuments(filter: DistributionFilter) {
        return DistributionRecord.countDocuments(filter);
    },

    create(data: Record<string, unknown>, session?: ClientSession) {
        if (session) {
            return DistributionRecord.create([data], { session }).then((items) => items[0]);
        }

        return DistributionRecord.create(data);
    },

    findById(id: string, session?: ClientSession) {
        const query = DistributionRecord.findOne({ _id: id, isDeleted: { $ne: true } })
            .populate('fromPlantId')
            .populate('toPlantId')
            .populate('purchaseOrderId')
            .populate('distributedBy')
            .populate('confirmedBy')
            .populate('supplyRequestId')
            .populate('items.materialId');

        if (session) {
            query.session(session);
        }

        return query;
    },

    findMany(filter: DistributionFilter, { limit, skip, sort = '-createdAt', session }: FindManyOptions = {}) {
        let query = buildDistributionQuery(filter).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        if (session) {
            query = query.session(session);
        }

        return query;
    },

    updateById(id: string, update: Record<string, unknown>, session?: ClientSession) {
        const query = DistributionRecord.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
            runValidators: true,
        })
            .populate('fromPlantId')
            .populate('toPlantId')
            .populate('purchaseOrderId')
            .populate('distributedBy')
            .populate('confirmedBy')
            .populate('supplyRequestId')
            .populate('items.materialId');

        if (session) {
            query.session(session);
        }

        return query;
    },
};
