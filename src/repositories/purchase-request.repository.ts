import PurchaseRequest from '@/models/PurchaseRequest';
import type { ClientSession } from 'mongoose';

type PurchaseRequestFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
    session?: ClientSession;
};

const buildPurchaseRequestQuery = (filter: PurchaseRequestFilter) =>
    PurchaseRequest.find(filter)
        .populate('plantId')
        .populate('fromPlantId')
        .populate('toPlantId')
        .populate('requestedBy')
        .populate('approvedBy')
        .populate('items.materialId')
        .populate('items.supplierId');

export const purchaseRequestRepository = {
    countDocuments(filter: PurchaseRequestFilter) {
        return PurchaseRequest.countDocuments(filter);
    },

    create(data: Record<string, unknown>, session?: ClientSession) {
        if (session) {
            return PurchaseRequest.create([data], { session }).then((items) => items[0]);
        }

        return PurchaseRequest.create(data);
    },

    findById(id: string, session?: ClientSession) {
        const query = PurchaseRequest.findOne({ _id: id, isDeleted: { $ne: true } })
            .populate('plantId')
            .populate('requestedBy')
            .populate('approvedBy')
            .populate('items.materialId')
            .populate('items.supplierId');

        if (session) {
            query.session(session);
        }

        return query;
    },

    findByIds(ids: string[], session?: ClientSession) {
        const query = PurchaseRequest.find({
            _id: { $in: ids },
            isDeleted: { $ne: true },
        })
            .populate('plantId')
            .populate('requestedBy')
            .populate('approvedBy')
            .populate('items.materialId')
            .populate('items.supplierId');

        if (session) {
            query.session(session);
        }

        return query;
    },

    findMany(filter: PurchaseRequestFilter, { limit, skip, sort = '-createdAt', session }: FindManyOptions = {}) {
        let query = buildPurchaseRequestQuery(filter).sort(sort);

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
        const query = PurchaseRequest.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
            runValidators: true,
        })
            .populate('plantId')
            .populate('requestedBy')
            .populate('approvedBy')
            .populate('items.materialId')
            .populate('items.supplierId');

        if (session) {
            query.session(session);
        }

        return query;
    },

    updateMany(filter: PurchaseRequestFilter, update: Record<string, unknown>, session?: ClientSession) {
        const query = PurchaseRequest.updateMany(filter, update);
        if (session) {
            query.session(session);
        }
        return query;
    },

    softDeleteById(id: string, update: Record<string, unknown>) {
        return PurchaseRequest.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
        });
    },
};
