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

export const imageUpload = createMemoryUpload(/\.(jpg|jpeg|png|webp|avif)$/i, UPLOAD_MESSAGES.INVALID_FILE_TYPE);

const CHAT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CHAT_AUDIO_MIME_TYPES = [
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/aac',
    'audio/x-m4a',
];

export const chatImageUpload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const validExtension = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname);
        const validMime = CHAT_IMAGE_MIME_TYPES.includes(file.mimetype);

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

export const chatAttachmentUpload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'images') {
            const validExtension = /\.(jpg|jpeg|png|webp)$/i.test(file.originalname);
            const normalizedMime = String(file.mimetype || '').split(';')[0].toLowerCase();
            const validMime = CHAT_IMAGE_MIME_TYPES.includes(normalizedMime);

            if (!validExtension || !validMime) {
                return cb(new BadRequestError(UPLOAD_MESSAGES.INVALID_FILE_TYPE));
            }

            return cb(null, true);
        }

        if (file.fieldname === 'audio') {
            const validExtension = /\.(webm|mp4|m4a|mp3|mpeg|wav|ogg|aac)$/i.test(file.originalname);
            const normalizedMime = String(file.mimetype || '').split(';')[0].toLowerCase();
            const validMime = CHAT_AUDIO_MIME_TYPES.includes(normalizedMime);

            if (!validExtension || !validMime) {
                return cb(new BadRequestError('Chi chap nhan ghi am hop le'));
            }

            return cb(null, true);
        }

        return cb(new BadRequestError('Truong tep dinh kem khong hop le'));
    },
    limits: {
        fileSize: 15 * 1024 * 1024,
        files: 5,
    },
});

export const audioUpload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const validExtension = /\.mp3$/i.test(file.originalname);
        const validMime = ['audio/mpeg', 'audio/mp3'].includes(file.mimetype);

        if (!validExtension || !validMime) {
            return cb(new BadRequestError('Chi chap nhan file am thanh MP3'));
        }

        cb(null, true);
    },
    limits: {
        fileSize: 3 * 1024 * 1024,
        files: 1,
    },
});

export const excelUpload = createMemoryUpload(/\.(xlsx|xls)$/i, 'Chi chap nhan file Excel co duoi XLSX hoac XLS');

export default imageUpload;
