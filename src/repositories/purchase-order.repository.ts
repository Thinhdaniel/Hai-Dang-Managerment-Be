import PurchaseOrder from '@/models/PurchaseOrder';
import type { ClientSession } from 'mongoose';

type Filter = Record<string, unknown>;
type FindOpts = { limit?: number; skip?: number; sort?: string; session?: ClientSession };

const withPopulate = (q: any) =>
    q.populate('createdBy', 'fullname email')
     .populate('orderedBy', 'fullname email')
     .populate('receivedBy', 'fullname email')
     .populate('plantId', 'name code')
     .populate('items.supplierId', 'name');

export const purchaseOrderRepository = {
    countDocuments: (filter: Filter) => PurchaseOrder.countDocuments(filter),

    create(data: Record<string, unknown>, session?: ClientSession) {
        if (session) return PurchaseOrder.create([data], { session }).then((r) => r[0]);
        return PurchaseOrder.create(data);
    },

    findById(id: string, session?: ClientSession) {
        const q = withPopulate(PurchaseOrder.findOne({ _id: id, isDeleted: { $ne: true } }));
        if (session) q.session(session);
        return q;
    },

    findMany(filter: Filter, { limit, skip, sort = '-createdAt', session }: FindOpts = {}) {
        let q = withPopulate(PurchaseOrder.find(filter)).sort(sort);
        if (typeof skip === 'number') q = q.skip(skip);
        if (typeof limit === 'number') q = q.limit(limit);
        if (session) q = q.session(session);
        return q;
    },

    updateById(id: string, update: Record<string, unknown>, session?: ClientSession) {
        const q = withPopulate(
            PurchaseOrder.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, { returnDocument: 'after', runValidators: true })
        );
        if (session) q.session(session);
        return q;
    },
};
