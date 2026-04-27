import { customAlphabet } from 'nanoid';

const PUBLIC_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MACHINE_PUBLIC_ID_LENGTH = 7;
const MAX_GENERATION_ATTEMPTS = 12;
const generateToken = customAlphabet(PUBLIC_ID_ALPHABET, MACHINE_PUBLIC_ID_LENGTH);

export const createMachinePublicId = () => `MC-${generateToken()}`;

export const generateUniqueMachinePublicId = async (
    isTaken: (publicId: string) => boolean | Promise<boolean>
) => {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
        const publicId = createMachinePublicId();
        if (!(await isTaken(publicId))) {
            return publicId;
        }
    }

    throw new Error('Unable to generate a unique machine public ID');
};
