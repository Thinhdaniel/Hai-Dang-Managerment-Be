import Plant from '@/models/Plant';

type PlantFilter = Record<string, unknown>;

type FindManyOptions = {
    sort?: string;
};

export const plantRepository = {
    create(data: Record<string, unknown>) {
        return Plant.create(data);
    },

    countDocuments(filter: PlantFilter) {
        return Plant.countDocuments(filter);
    },

    findById(id: string) {
        return Plant.findOne({ _id: id, isDeleted: { $ne: true } });
    },

    findMany(filter: PlantFilter, { sort = 'name' }: FindManyOptions = {}) {
        return Plant.find(filter).sort(sort);
    },

    findNameConflict({ normalizedName, excludeId }: { normalizedName: string; excludeId?: string }) {
        return Plant.findOne({
            normalizedName,
            isDeleted: { $ne: true },
            ...(excludeId ? { _id: { $ne: excludeId } } : {}),
        })
            .select('_id name')
            .lean();
    },

    updateById(id: string, update: Record<string, unknown>) {
        return Plant.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            returnDocument: 'after',
            runValidators: true,
        });
    },

    softDeleteById(id: string, update: Record<string, unknown>) {
        return Plant.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            returnDocument: 'after',
        });
    },
};
