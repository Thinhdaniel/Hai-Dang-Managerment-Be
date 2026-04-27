import { BadRequestFormError } from '@/errors/customError';
import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ReasonPhrases, StatusCodes } from 'http-status-codes';

const errorHandler: ErrorRequestHandler = (err, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
        return next(err);
    }
    const status = err.status || StatusCodes.INTERNAL_SERVER_ERROR;
    const message = err.message || ReasonPhrases.INTERNAL_SERVER_ERROR;
    const name = err.name || 'Error';

    if (err instanceof BadRequestFormError) {
        return res.status(status).json({
            success: false,
            status,
            message,
            errors: err.errors,
        });
    }
    return res.status(status).json({
        data: null,
        success: false,
        status,
        name,
        message,
    });
};

export default errorHandler;
