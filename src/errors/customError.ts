import { ReasonPhrases, StatusCodes } from 'http-status-codes';
import { HttpException } from './HttpException.js';

export class NotFoundError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.NOT_FOUND;
        this.status = StatusCodes.NOT_FOUND;
    }
}
export class BadRequestFormError extends Error {
    public status: number;
    public name: string;
    public errors: { message: string; field: string }[];

    constructor(
        message: string,
        errors: { message: string; field: string } | { message: string; field: string }[],
        status?: number
    ) {
        super(message);
        this.name = ReasonPhrases.BAD_REQUEST;
        this.status = status || StatusCodes.BAD_REQUEST;
        this.errors = Array.isArray(errors) ? errors : [errors];
    }
}
export class BadRequestError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.BAD_REQUEST;
        this.status = StatusCodes.BAD_REQUEST;
    }
}
export class DuplicateError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.CONFLICT;
        this.status = StatusCodes.CONFLICT;
    }
}
export class UnAuthenticatedError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.UNAUTHORIZED;
        this.status = StatusCodes.UNAUTHORIZED;
    }
}
export class UnAuthorizedError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.FORBIDDEN;
        this.status = StatusCodes.FORBIDDEN;
    }
}

export class TooManyRequestsError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.TOO_MANY_REQUESTS;
        this.status = StatusCodes.TOO_MANY_REQUESTS;
    }
}

export class NotAcceptableError extends HttpException {
    public status: number;
    public name: string;

    constructor(message: string) {
        super(message);
        this.name = ReasonPhrases.NOT_ACCEPTABLE;
        this.status = StatusCodes.NOT_ACCEPTABLE;
    }
}
