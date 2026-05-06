import Supplier from '@/models/Supplier';

type SupplierFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
};

const buildSupplierQuery = (filter: SupplierFilter) => Supplier.find(filter).populate('createdBy').populate('updatedBy');

export const supplierRepository = {
    countDocuments(filter: SupplierFilter) {
        return Supplier.countDocuments(filter);
    },

    create(data: Record<string, unknown>) {
        return Supplier.create(data);
    },

    findById(id: string) {
        return Supplier.findOne({ _id: id, isDeleted: { $ne: true } }).populate('createdBy').populate('updatedBy');
    },

    findMany(filter: SupplierFilter, { limit, skip, sort = '-createdAt' }: FindManyOptions = {}) {
        let query = buildSupplierQuery(filter).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        return query;
    },

    updateById(id: string, update: Record<string, unknown>) {
        return Supplier.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
            runValidators: true,
        })
            .populate('createdBy')
            .populate('updatedBy');
    },
};
