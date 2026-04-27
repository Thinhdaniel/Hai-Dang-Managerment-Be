export const getPagination = (query: Record<string, any>) => {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.max(Number(query.limit) || 10, 1);
    const skip = (page - 1) * limit;

    return { page, limit, skip };
};

export const buildPaginatedResponse = <T>(items: T[], total: number, page: number, limit: number) => ({
    data: items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
});
