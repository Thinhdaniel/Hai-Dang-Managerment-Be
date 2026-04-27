import User from '@/models/User';

const slugify = (value: string) =>
    value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/(^\.|\.$)/g, '')
        .slice(0, 24) || 'user';

export const buildUniqueUsername = async (seed: string, excludeId?: string) => {
    const base = slugify(seed);
    let username = base;
    let index = 1;

    while (
        await User.exists({
            username,
            ...(excludeId ? { _id: { $ne: excludeId } } : {}),
        })
    ) {
        username = `${base}.${index}`;
        index += 1;
    }

    return username;
};
