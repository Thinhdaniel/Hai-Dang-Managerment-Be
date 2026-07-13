import { v2 as cloudinary } from 'cloudinary';
import config from '@/config/env.config';
import cloudinaryConfig from '@/config/cloudinary.config';
import { vertexProviderService } from '@/services/ai/vertex-provider.service';

const PROMPT_VERSION = 'executive-digest-cover-v1';

cloudinary.config(cloudinaryConfig);

export type DigestVisualResult = {
    status: 'disabled' | 'ready' | 'fallback' | 'failed';
    coverImageUrl?: string;
    provider?: string;
    model?: string;
    generatedAt?: Date;
    promptVersion: string;
    error?: string;
    aiGenerated: boolean;
};

const collectReferenceImages = (snapshot: any) => {
    const urls: string[] = [];
    for (const item of snapshot?.successfulRepairs || []) {
        for (const url of [...(item.beforeImages || []), ...(item.afterImages || [])]) {
            if (typeof url === 'string' && url.startsWith('http') && !urls.includes(url)) urls.push(url);
            if (urls.length >= 4) return urls;
        }
    }
    return urls;
};

const buildCoverPrompt = (periodLabel: string, hasReferences: boolean) =>
    [
        'Create a premium editorial cover image for an internal weekly operations brief of a large Vietnamese garment manufacturing company.',
        'Show modern industrial sewing machines, maintenance work, material storage and factory operations in a realistic documentary photography style.',
        hasReferences
            ? 'Use the supplied factory photos only as visual context; preserve machine identity and do not invent damage or repairs.'
            : 'Use a realistic garment factory environment with clean industrial lighting.',
        'Composition: strong central subject, reserved dark negative space near the upper-left for application-rendered title, subtle blue and safety-green accents, professional annual-report quality.',
        `Editorial period context: ${periodLabel}.`,
        'Do not render any text, numbers, logos, badges, charts, QR codes, watermarks or signatures.',
        'Do not make the factory futuristic, cinematic, damaged, unsafe or staged like stock photography.',
    ].join('\n');

export const generateDigestVisual = async (
    snapshot: any,
    options: { periodKey: string; periodLabel: string; version: number }
): Promise<DigestVisualResult> => {
    const referenceImages = collectReferenceImages(snapshot);
    if (!config.vertex.imageEnabled || !vertexProviderService.isEnabled()) {
        return referenceImages[0]
            ? {
                  status: 'fallback',
                  coverImageUrl: referenceImages[0],
                  promptVersion: PROMPT_VERSION,
                  aiGenerated: false,
              }
            : { status: 'disabled', promptVersion: PROMPT_VERSION, aiGenerated: false };
    }

    try {
        const generated = await vertexProviderService.generateImage({
            prompt: buildCoverPrompt(options.periodLabel, referenceImages.length > 0),
            model: config.vertex.imageModel,
            aspectRatio: '4:5',
            imageSize: '1K',
            referenceImages,
        });
        const source = generated.dataUrl || generated.url;
        if (!source) throw new Error('Vertex did not return an image');

        const uploaded = await cloudinary.uploader.upload(source, {
            folder: 'hai-dang/executive-digests',
            public_id: `${options.periodKey}-v${options.version}-${Date.now()}`,
            resource_type: 'image',
            overwrite: false,
            tags: ['executive-digest', 'ai-generated'],
        });

        return {
            status: 'ready',
            coverImageUrl: uploaded.secure_url,
            provider: generated.provider,
            model: generated.model,
            generatedAt: new Date(),
            promptVersion: PROMPT_VERSION,
            aiGenerated: true,
        };
    } catch (error) {
        if (referenceImages[0]) {
            return {
                status: 'fallback',
                coverImageUrl: referenceImages[0],
                generatedAt: new Date(),
                promptVersion: PROMPT_VERSION,
                error: (error instanceof Error ? error.message : 'Khong tao duoc anh').slice(0, 300),
                aiGenerated: false,
            };
        }
        return {
            status: 'failed',
            generatedAt: new Date(),
            promptVersion: PROMPT_VERSION,
            error: (error instanceof Error ? error.message : 'Khong tao duoc anh').slice(0, 300),
            aiGenerated: false,
        };
    }
};
