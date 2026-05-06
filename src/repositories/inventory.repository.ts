import InventoryStock from '@/models/InventoryStock';
import type { ClientSession } from 'mongoose';

type InventoryFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
    session?: ClientSession;
};

const buildInventoryQuery = (filter: InventoryFilter) =>
    (InventoryStock as any).find(filter as any).populate('materialId').populate('plantId');

export const inventoryRepository = {
    countDocuments(filter: InventoryFilter) {
        return (InventoryStock as any).countDocuments(filter as any);
    },

    findById(id: string) {
        return (InventoryStock as any)
            .findOne({ _id: id, isDeleted: { $ne: true } })
            .populate('materialId')
            .populate('plantId');
    },

    findOne(filter: InventoryFilter, session?: ClientSession) {
        const query = (InventoryStock as any).findOne(filter as any).populate('materialId').populate('plantId');
        if (session) {
            query.session(session);
        }
        return query;
    },

    findMany(filter: InventoryFilter, { limit, skip, sort = '-lastUpdated', session }: FindManyOptions = {}) {
        let query = buildInventoryQuery(filter).sort(sort);

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
};
