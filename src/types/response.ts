export interface ResponseT<T> {
    success: boolean;
    status: number;
    message: string;
    data: T;
}
