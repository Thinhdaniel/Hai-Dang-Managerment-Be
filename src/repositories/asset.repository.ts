import Asset from '@/models/Asset';
import { ASSET_OWNERSHIP_TYPE } from '@/constant/assetStatus';
import mongoose from 'mongoose';

type AssetFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
};

const buildAssetQuery = (filter: AssetFilter) => Asset.find(filter).populate('brandId').populate('plantId');

export const assetRepository = {
    countDocuments(filter: AssetFilter) {
        return Asset.countDocuments(filter);
    },

    create(data: Record<string, unknown>) {
        return Asset.create(data);
    },

    existsByPublicId(publicId: string) {
        return Asset.exists({ publicId });
    },

    findById(id: string) {
        return Asset.findOne({ _id: id, isDeleted: { $ne: true } })
            .populate('brandId')
            .populate('plantId');
    },

    findByPublicId(publicId: string) {
        return Asset.findOne({ publicId, isDeleted: { $ne: true } }).populate('plantId');
    },

    findMany(filter: AssetFilter, { limit, skip, sort = '-createdAt' }: FindManyOptions = {}) {
        let query = buildAssetQuery(filter).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        return query;
    },

    updateById(id: string, update: Record<string, unknown>) {
        return Asset.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
            runValidators: true,
        })
            .populate('brandId')
            .populate('plantId');
    },

    softDeleteById(id: string, update: Record<string, unknown>) {
        return Asset.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, update, {
            new: true,
        });
    },

    findExistingMachineCodes(machineCodes: string[]) {
        return Asset.find({ machineCode: { $in: machineCodes } })
            .select('machineCode')
            .lean();
    },

    insertMany(documents: Record<string, unknown>[]) {
        return Asset.insertMany(documents, { ordered: false });
    },

    async countGroupedByPlantIds(plantIds: string[]) {
        if (!plantIds.length) {
            return new Map<string, number>();
        }

        const rows = await Asset.aggregate<{ _id: string; count: number }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                    plantId: { $in: plantIds.map((id) => new mongoose.Types.ObjectId(id)) },
                },
            },
            {
                $group: {
                    _id: '$plantId',
                    count: { $sum: 1 },
                },
            },
        ]);

        return new Map(rows.map((row) => [String(row._id), row.count]));
    },

    async getPlantMachineStats() {
        const [result] = await Asset.aggregate<{
            countsByPlant: { _id: mongoose.Types.ObjectId | null; count: number }[];
            summary: { totalMachines: number; unassignedMachines: number }[];
        }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    $or: [{ ownershipType: ASSET_OWNERSHIP_TYPE.OWNED }, { ownershipType: { $exists: false } }],
                },
            },
            {
                $facet: {
                    countsByPlant: [
                        {
                            $group: {
                                _id: '$plantId',
                                count: { $sum: 1 },
                            },
                        },
                    ],
                    summary: [
                        {
                            $group: {
                                _id: null,
                                totalMachines: { $sum: 1 },
                                unassignedMachines: {
                                    $sum: {
                                        $cond: [{ $ifNull: ['$plantId', false] }, 0, 1],
                                    },
                                },
                            },
                        },
                        {
                            $project: {
                                _id: 0,
                                totalMachines: 1,
                                unassignedMachines: 1,
                            },
                        },
                    ],
                },
            },
        ]);

        const countsByPlant = new Map(
            (result?.countsByPlant ?? []).filter((row) => row._id).map((row) => [String(row._id), row.count])
        );

        return {
            countsByPlant,
            totalMachines: result?.summary?.[0]?.totalMachines ?? 0,
            unassignedMachines: result?.summary?.[0]?.unassignedMachines ?? 0,
        };
    },

    async getDistinctNames() {
        const rows = await Asset.aggregate<{ _id: string }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    name: { $exists: true, $ne: '' },
                },
            },
            {
                $group: {
                    _id: '$name',
                },
            },
            {
                $sort: {
                    _id: 1,
                },
            },
        ]);

        return rows.map((row) => row._id).filter(Boolean);
    },

    async getDistinctModels() {
        const rows = await Asset.aggregate<{ _id: string }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                },
            },
            {
                $project: {
                    effectiveModel: { $ifNull: ['$model', '$type'] },
                },
            },
            {
                $match: {
                    effectiveModel: { $type: 'string', $ne: '' },
                },
            },
            {
                $group: {
                    _id: '$effectiveModel',
                },
            },
            {
                $sort: {
                    _id: 1,
                },
            },
        ]);

        return rows.map((row) => row._id);
    },

    async getDistinctTypes() {
        const rows = await Asset.aggregate<{ _id: string }>([
            {
                $match: {
                    isDeleted: { $ne: true },
                    type: { $type: 'string', $ne: '' },
                },
            },
            {
                $group: {
                    _id: '$type',
                },
            },
            {
                $sort: {
                    _id: 1,
                },
            },
        ]);

        return rows.map((row) => row._id);
    },
};
