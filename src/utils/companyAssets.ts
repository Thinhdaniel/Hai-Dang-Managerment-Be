import axios from 'axios';

const LOGO_URL =
    'https://res.cloudinary.com/dn0kgs7mi/image/upload/v1777213524/461879796_122098397930558026_2620600354798656289_n_rj6ylo.png';

let logoBuffer: Buffer | null = null;

export async function getLogoBuffer(): Promise<Buffer | null> {
    if (logoBuffer) return logoBuffer;
    try {
        const res = await axios.get(LOGO_URL, { responseType: 'arraybuffer', timeout: 5000 });
        logoBuffer = Buffer.from(res.data);
        return logoBuffer;
    } catch {
        return null;
    }
}
