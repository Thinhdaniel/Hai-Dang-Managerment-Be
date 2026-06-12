import { UPLOAD_MESSAGES } from '@/constant/messages';
import { BadRequestError } from '@/errors/customError';
import multer from 'multer';

const storage = multer.memoryStorage();

const createMemoryUpload = (pattern: RegExp, invalidFileMessage: string) =>
    multer({
        storage,
        fileFilter: (req, file, cb) => {
            if (!pattern.test(file.originalname)) {
                return cb(new BadRequestError(invalidFileMessage));
            }
            cb(null, true);
        },
        limits: { fileSize: 100 * 1024 * 1024 },
    });

export const imageUpload = createMemoryUpload(
    /\.(jpg|jpeg|png|webp|avif)$/i,
    UPLOAD_MESSAGES.INVALID_FILE_TYPE
);

export const chatImageUpload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const validExtension = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname);
        const validMime = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);

        if (!validExtension || !validMime) {
            return cb(new BadRequestError(UPLOAD_MESSAGES.INVALID_FILE_TYPE));
        }

        cb(null, true);
    },
    limits: {
        fileSize: 8 * 1024 * 1024,
        files: 4,
    },
});

export const excelUpload = createMemoryUpload(
    /\.(xlsx|xls)$/i,
    'Chi chap nhan file Excel co duoi XLSX hoac XLS'
);

export default imageUpload;
