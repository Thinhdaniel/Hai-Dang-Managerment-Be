import { ResponseT } from '@/types/response';

export const customResponse = <T>({ data, success, message, status }: ResponseT<T>) => {
    return data;
};

export default customResponse;
