import { z } from 'zod';
import { AI_FEATURES } from '@/constant/aiModels';
import { aiProviderService } from '@/services/ai/ai-provider.service';
import { buildGroundingEvidence, type AssistantEvidenceEntry } from '@/services/ai/assistant-evidence.service';

const groundingSchema = z.object({
    valid: z.boolean(),
    correctedAnswer: z.string().trim().max(8000).optional(),
    issues: z.array(z.string().trim().max(300)).max(8).optional(),
});

export type AssistantGroundingStatus = 'verified' | 'corrected' | 'unverified' | 'not_applicable';

export type AssistantGroundingResult = {
    answer: string;
    status: AssistantGroundingStatus;
    issues?: string[];
};

const numericTokens = (value: string) => value.match(/\d+(?:[.,]\d+)*/g) ?? [];

const correctionUsesOnlyEvidenceNumbers = (answer: string, evidence: string) =>
    numericTokens(answer).every((token) => evidence.includes(token));

export const shouldVerifyAssistantAnswer = (answer: string, evidence: AssistantEvidenceEntry[], provider: string) =>
    evidence.length > 0 && !['fallback', 'heuristic', 'policy'].includes(provider) && numericTokens(answer).length > 0;

export const verifyAssistantGrounding = async (
    answer: string,
    evidenceEntries: AssistantEvidenceEntry[],
    modelOverride?: string
): Promise<AssistantGroundingResult> => {
    if (!evidenceEntries.length) return { answer, status: 'not_applicable' };
    const evidence = buildGroundingEvidence(evidenceEntries);

    try {
        const generated = await aiProviderService.generateJson<unknown>({
            feature: AI_FEATURES.ASSET_ANSWER,
            model: modelOverride,
            temperature: 0,
            maxTokens: 1000,
            timeoutMs: 20000,
            reasoningEffort: 'low',
            messages: [
                {
                    role: 'system',
                    content: [
                        'Bạn là bộ kiểm chứng câu trả lời vận hành dựa trên bằng chứng từ hệ thống.',
                        'Kiểm tra mọi con số, mã phiếu, mã máy, tên cơ sở và khẳng định thực tế trong câu trả lời.',
                        'Không bổ sung kiến thức ngoài bằng chứng. Không thay đổi ý nếu câu trả lời đã đúng.',
                        'Trả JSON: {"valid":true|false,"correctedAnswer":"...","issues":["..."]}.',
                        'Nếu sai hoặc vượt quá bằng chứng, valid=false và correctedAnswer phải là câu hoàn chỉnh đã sửa.',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: `CAU TRA LOI:\n${answer}\n\nBANG CHUNG HE THONG:\n${evidence}`,
                },
            ],
        });
        const checked = groundingSchema.parse(generated.data);
        if (checked.valid) return { answer, status: 'verified', issues: checked.issues };
        if (checked.correctedAnswer && correctionUsesOnlyEvidenceNumbers(checked.correctedAnswer, evidence)) {
            return { answer: checked.correctedAnswer, status: 'corrected', issues: checked.issues };
        }
        return { answer, status: 'unverified', issues: checked.issues };
    } catch {
        return { answer, status: 'unverified' };
    }
};
