import StockTransaction from '@/models/StockTransaction';

type StockTransactionFilter = Record<string, unknown>;

type FindManyOptions = {
    limit?: number;
    skip?: number;
    sort?: string;
};

const buildStockTransactionQuery = (filter: StockTransactionFilter) =>
    StockTransaction.find(filter).populate('materialId').populate('plantId').populate('performedBy');

export const stockTransactionRepository = {
    countDocuments(filter: StockTransactionFilter) {
        return StockTransaction.countDocuments(filter);
    },

    findMany(filter: StockTransactionFilter, { limit, skip, sort = '-createdAt' }: FindManyOptions = {}) {
        let query = buildStockTransactionQuery(filter).sort(sort);

        if (typeof skip === 'number') {
            query = query.skip(skip);
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        return query;
    },
};
