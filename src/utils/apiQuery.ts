import _ from 'lodash';
import mongoose, { Document, Query } from 'mongoose';

export interface QueryString {
    [key: string]: any;
    page?: string;
    sort?: string;
    limit?: string;
    fields?: string;
}

class APIQuery<T extends Document> {
    public query: Query<T[], T>;
    public queryString: QueryString;

    constructor(query: Query<T[], T>, queryString: QueryString) {
        this.query = query;
        this.queryString = queryString;
    }

    /**
     * Filters the query based on the provided query parameters.
     * It removes parameters that are not related to filtering (page, sort, limit, fields, search)
     * and applies MongoDB operators (gte, gt, lte, lt) for filtering.
     * @example /api/v1/products?price[gte]=100&price[lte]=500&name=iphone
     */
    filter(): APIQuery<T> {
        const queryObj = { ...this.queryString };
        const excludedFields = ['page', 'sort', 'limit', 'fields', 'search'];
        excludedFields.forEach((el) => delete queryObj[el]);
        // Remove 'raw' fields from queryObj (remove manual fields)
        console.log(queryObj);
        Object.keys(queryObj).forEach((el) => {
            if (el.includes('raw')) {
                delete queryObj[el];
            }
        });
        Object.keys(queryObj).forEach((el) => {
            if (String(queryObj[el]).includes(',')) {
                queryObj[el] = { $in: String(queryObj[el]).split(',') };
            }
        });
        let queryStr = JSON.stringify(queryObj);
        queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);

        this.query = this.query.find(JSON.parse(queryStr));

        if (this.queryString.isDeleted === undefined) {
            this.query = this.query.find({ isDeleted: { $ne: true } } as any);
        }

        return this;
    }

    /**
     * Sorts the query results based on the provided query parameters.
     * If no sort parameter is provided, it defaults to sorting by the creation date in descending order.
     * @example /api/v1/products?sort=-price,rating,createdAt
     */
    sort(): APIQuery<T> {
        if (this.queryString.sort) {
            const sortBy = this.queryString.sort.split(',').join(' ');
            this.query = this.query.sort(sortBy);
        } else {
            this.query = this.query.sort('-createdAt');
        }

        return this;
    }

    /**
     * Limits the fields returned in the query results based on the provided query parameters.
     * If no fields parameter is provided, it excludes the '__v' field.
     * @example /api/v1/products?fields=name,price,rating
     */
    limitFields(): APIQuery<T> {
        if (this.queryString.fields) {
            const fields = this.queryString.fields.split(',').join(' ');
            this.query = this.query.select(fields);
        } else {
            this.query = this.query.select('-__v');
        }

        return this;
    }

    /**
     * Searches the query results based on the provided search parameter.
     * It checks if the search parameter is a valid ObjectId. If so, it searches by _id,
     * otherwise, it searches by name using a regular expression.
     * @example /api/v1/products?search=iphone
     */
    search(): APIQuery<T> {
        if (this.queryString.search) {
            const isId = mongoose.Types.ObjectId.isValid(this.queryString.search);
            if (isId) {
                const search = this.queryString.search;
                this.query = this.query.find({ _id: search });
            } else {
                const search = _.toLower(this.queryString.search);
                this.query = this.query.find({ name: { $regex: search, $options: 'i' } });
            }
        }
        return this;
    }

    /**
     * Paginates the query results based on the provided page and limit parameters.
     * Defaults to page 1 and limit 10 if not provided.
     * @example /api/v1/products?page=2&limit=20
     */
    paginate() {
        const page = Number(this.queryString.page) || 1;
        const limit = Number(this.queryString.limit) || 10;
        const skip = (page - 1) * limit;

        this.query = this.query.skip(skip).limit(limit);

        return this;
    }

    /**
     * Counts the total number of documents matching the query.
     * @returns {Promise<number>} - The total number of matching documents
     */
    async count() {
        const totalDocs = await this.query.model.countDocuments(this.query.getQuery());
        return totalDocs;
    }
}

export default APIQuery;
