import Material from '@/models/Material';

type MaterialFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
};

const buildMaterialQuery = (filter: MaterialFilter) => Material.find(filter).populate('createdBy').populate('updatedBy');

export const materialRepository = {
    countDocuments(filter: MaterialFilter) {
        return Material.countDocuments(filter);
    },

    create(data: Record<string, unknown>) {
        return Material.create(data);
    },

    findById(id: string) {
        return Material.findOne({ _id: id, isDeleted: { $ne: true } }).populate('createdBy').populate('updatedBy');
    },

    findByIds(ids: string[]) {
        return Material.find({
            _id: { $in: ids },
            isDeleted: { $ne: true },
        });
    },

    findMany(filter: MaterialFilter, { limit, skip, sort = '-createdAt' }: FindManyOptions = {}) {
        let query = buildMaterialQuery(filter).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        return query;
    },

    updateById(id: string, update: Record<string, unknown>) {
        return Material.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
            runValidators: true,
        })
            .populate('createdBy')
            .populate('updatedBy');
    },

    softDeleteById(id: string, update: Record<string, unknown>) {
        return Material.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
        });
    },
};
