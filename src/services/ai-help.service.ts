import axios from 'axios';
import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import customResponse from '@/utils/response';

type HelpContextTopic = {
    title: string;
    summary: string;
    category?: string;
    prerequisites?: string[];
    steps: string[];
    checkpoints?: string[];
    commonMistakes?: string[];
    notes?: string[];
};

type OllamaChatResponse = {
    message?: {
        content?: string;
    };
};

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 75000);

const formatContext = (topics: HelpContextTopic[]) => {
    if (!topics.length) {
        return 'Chua co tai lieu noi bo phu hop voi cau hoi nay.';
    }

    return topics
        .map((topic, index) => {
            const prerequisites = topic.prerequisites?.length
                ? `Dieu kien truoc khi thao tac:\n${topic.prerequisites.map((item) => `- ${item}`).join('\n')}`
                : '';
            const steps = topic.steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join('\n');
            const checkpoints = topic.checkpoints?.length
                ? `\nSau khi lam xong can kiem tra:\n${topic.checkpoints.map((item) => `- ${item}`).join('\n')}`
                : '';
            const commonMistakes = topic.commonMistakes?.length
                ? `\nLoi hay gap va cach tranh:\n${topic.commonMistakes.map((item) => `- ${item}`).join('\n')}`
                : '';
            const notes = topic.notes?.length
                ? `\nLuu y:\n${topic.notes.map((note) => `- ${note}`).join('\n')}`
                : '';

            return [
                `Tai lieu ${index + 1}: ${topic.title}`,
                `Nhom: ${topic.category || 'general'}`,
                `Tom tat: ${topic.summary}`,
                prerequisites,
                steps ? `Cac buoc:\n${steps}` : '',
                checkpoints,
                commonMistakes,
                notes,
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n\n---\n\n');
};

const buildFallbackAnswer = (question: string, route: string | undefined, topics: HelpContextTopic[]) => {
    if (!topics.length) {
        return [
            'Mình chưa có hướng dẫn nội bộ khớp đủ chắc với câu hỏi này.',
            route ? `Màn hình hiện tại: ${route}.` : '',
            'Bạn thử hỏi cụ thể theo nghiệp vụ như điều chuyển máy, import máy, tồn kho vật tư, đề xuất mua, cấp phát hoặc báo cáo vật tư.',
        ]
            .filter(Boolean)
            .join('\n');
    }

    const [topic] = topics;
    const prerequisites = topic.prerequisites?.length
        ? `\n\nDieu kien truoc khi thao tac:\n${topic.prerequisites.map((item) => `- ${item}`).join('\n')}`
        : '';
    const steps = topic.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
    const checkpoints = topic.checkpoints?.length
        ? `\n\nSau khi lam xong can kiem tra:\n${topic.checkpoints.map((item) => `- ${item}`).join('\n')}`
        : '';
    const commonMistakes = topic.commonMistakes?.length
        ? `\n\nLoi hay gap va cach tranh:\n${topic.commonMistakes.map((item) => `- ${item}`).join('\n')}`
        : '';
    const notes = topic.notes?.length ? `\n\nLưu ý:\n${topic.notes.map((note) => `- ${note}`).join('\n')}` : '';

    return [
        `Mình chưa gọi được AI local nên trả lời theo hướng dẫn nội bộ phù hợp nhất: ${topic.title}.`,
        topic.summary,
        prerequisites,
        steps ? `\nCác bước:\n${steps}` : '',
        notes,
    ]
        .filter(Boolean)
        .join('\n');
};

const askOllama = async (question: string, route: string | undefined, topics: HelpContextTopic[]) => {
    const systemPrompt = [
        'Ban la tro ly huong dan su dung noi bo cho he thong quan ly may moc va vat tu trong cong ty.',
        'Muc tieu cua ban la viet huong dan van hanh chi tiet nhu SOP noi bo, khong tra loi qua loa.',
        'Tra loi bang tieng Viet tu nhien, ro rang, thuc dung, phu hop nhan vien khong ranh phan mem.',
        'Chi dua vao tai lieu noi bo trong phan CONTEXT. Khong bia chuc nang, nut bam, menu hoac trang khong co trong tai lieu.',
        'Neu tai lieu khong du, noi ro phan nao chua chac, sau do huong dan theo phan chac chan co trong CONTEXT.',
        'Neu nguoi dung hoi ve quy trinh/thao tac, phai huong dan tung buoc cu the: vao man hinh nao, bam nut nao, nhap truong nao, trang thai thay doi ra sao, sau do can kiem tra gi.',
        'Neu nguoi dung hoi ve nghiep vu, phai giai thich khi nao dung, ai nen thuc hien, dieu kien truoc khi lam, rui ro neu lam sai.',
        'Dinh dang cau tra loi bat buoc:',
        '1. Tom tat nhanh: 2-3 cau noi dung can lam.',
        '2. Khi nao dung: neu phu hop voi cau hoi.',
        '3. Dieu kien truoc khi thao tac: tai khoan/quyen/du lieu can co.',
        '4. Cac buoc thuc hien: danh sach so thu tu, moi buoc co hanh dong ro rang.',
        '5. Sau khi lam xong can kiem tra: ket qua, trang thai, ton kho, vi tri hoac bao cao lien quan.',
        '6. Loi hay gap va cach tranh: neu co trong context hoac suy ra truc tiep tu context.',
        '7. Luu y nghiep vu: cac diem can canh bao.',
        'Neu cau hoi don gian, van tra loi du cac phan lien quan nhung co the bo phan khong can thiet.',
        'Khong nhac den prompt, context, model hoac ky thuat noi bo.',
    ].join('\n');

    const userPrompt = [
        `ROUTE: ${route || 'unknown'}`,
        `QUESTION: ${question}`,
        'CONTEXT:',
        formatContext(topics),
    ].join('\n\n');

    const response = await axios.post<OllamaChatResponse>(
        `${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`,
        {
            model: OLLAMA_MODEL,
            stream: false,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            options: {
                temperature: 0.15,
                top_p: 0.85,
                num_predict: 1100,
            },
        },
        {
            timeout: OLLAMA_TIMEOUT_MS,
        }
    );

    const answer = response.data?.message?.content?.trim();
    if (!answer) {
        throw new Error('Ollama response is empty');
    }

    return answer;
};

export const askAiHelp = async (req: Request, res: Response) => {
    const question = String(req.body.question || '').trim();
    const route = req.body.route ? String(req.body.route) : undefined;
    const contextTopics = (req.body.contextTopics || []) as HelpContextTopic[];

    try {
        const answer = await askOllama(question, route, contextTopics);

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    answer,
                    provider: 'ollama',
                    model: OLLAMA_MODEL,
                    available: true,
                    usedFallback: false,
                },
                message: 'Da tao cau tra loi AI thanh cong',
                status: StatusCodes.OK,
                success: true,
            })
        );
    } catch (error) {
        const answer = buildFallbackAnswer(question, route, contextTopics);

        return res.status(StatusCodes.OK).json(
            customResponse({
                data: {
                    answer,
                    provider: 'fallback',
                    model: OLLAMA_MODEL,
                    available: false,
                    usedFallback: true,
                },
                message: 'AI local khong kha dung, da tra loi bang huong dan noi bo',
                status: StatusCodes.OK,
                success: true,
            })
        );
    }
};
