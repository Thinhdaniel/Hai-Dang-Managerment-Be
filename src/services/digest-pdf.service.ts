import { createRequire } from 'node:module';
import axios from 'axios';
import PDFDocument from 'pdfkit';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import cloudinaryConfig from '@/config/cloudinary.config';
import { getLogoBuffer } from '@/utils/companyAssets';
import { applyDigestEditorial, getDigestChecksum } from '@/services/digest-validation.service';

const require = createRequire(import.meta.url);
const REGULAR_FONT = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf');
const BOLD_FONT = require.resolve('@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf');

cloudinary.config(cloudinaryConfig);

const COLORS = {
    ink: '#172033',
    text: '#344054',
    muted: '#667085',
    line: '#DDE3EA',
    soft: '#F5F7FA',
    blue: '#3157C8',
    green: '#137253',
    amber: '#A15D08',
    red: '#B93746',
    white: '#FFFFFF',
};

const n = (value: unknown, fraction = 0) =>
    new Intl.NumberFormat('vi-VN', { maximumFractionDigits: fraction }).format(Number(value || 0));
const vnd = (value: unknown) => `${n(value)} đ`;
const text = (value: unknown, fallback = '-') =>
    String(value ?? '')
        .normalize('NFC')
        .replace(/[–—−]/g, '-')
        .trim() || fallback;

const getCloudinaryPngUrl = (value: string) => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com') return null;
        return value.includes('/image/upload/')
            ? value.replace('/image/upload/', '/image/upload/f_png,q_auto,w_1400/')
            : value;
    } catch {
        return null;
    }
};

const fetchImage = async (url?: string): Promise<Buffer | null> => {
    if (!url) return null;
    const safeUrl = getCloudinaryPngUrl(url);
    if (!safeUrl) return null;
    try {
        const response = await axios.get<ArrayBuffer>(safeUrl, {
            responseType: 'arraybuffer',
            timeout: 8000,
            maxContentLength: 8 * 1024 * 1024,
        });
        return Buffer.from(response.data);
    } catch {
        return null;
    }
};

const ensureSpace = (doc: PDFKit.PDFDocument, height: number) => {
    const bottom = doc.page.height - doc.page.margins.bottom - 24;
    if (doc.y + height > bottom) doc.addPage();
};

const drawSectionTitle = (doc: PDFKit.PDFDocument, index: string, title: string, subtitle?: string) => {
    ensureSpace(doc, subtitle ? 55 : 38);
    const y = doc.y;
    doc.roundedRect(doc.page.margins.left, y, 26, 26, 4).fill(COLORS.ink);
    doc.font('NotoBold')
        .fontSize(8)
        .fillColor(COLORS.white)
        .text(index, doc.page.margins.left, y + 8, {
            width: 26,
            align: 'center',
        });
    doc.font('NotoBold')
        .fontSize(15)
        .fillColor(COLORS.ink)
        .text(title, doc.page.margins.left + 36, y + 1);
    if (subtitle) {
        doc.font('Noto')
            .fontSize(8.5)
            .fillColor(COLORS.muted)
            .text(subtitle, doc.page.margins.left + 36, y + 22);
    }
    doc.y = y + (subtitle ? 48 : 36);
};

const drawBulletList = (doc: PDFKit.PDFDocument, items: unknown[], color = COLORS.blue) => {
    if (!items.length) {
        doc.font('Noto').fontSize(9).fillColor(COLORS.muted).text('Không có nội dung đáng chú ý.');
        return;
    }
    for (const item of items.slice(0, 8)) {
        ensureSpace(doc, 28);
        const y = doc.y;
        doc.circle(doc.page.margins.left + 3, y + 6, 2).fill(color);
        doc.font('Noto')
            .fontSize(9)
            .fillColor(COLORS.text)
            .text(text(item), doc.page.margins.left + 12, y, {
                width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 12,
                lineGap: 2,
            });
        doc.moveDown(0.35);
    }
};

const drawKpis = (doc: PDFKit.PDFDocument, snapshot: any) => {
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const gap = 7;
    const width = (pageWidth - gap * 2) / 3;
    const kpis = [
        ['Máy hoạt động', `${n(snapshot.machines?.active)}/${n(snapshot.machines?.total)}`, 'Toàn hệ thống'],
        ['Phiếu mới', n(snapshot.maintenance?.newTickets), 'Trong kỳ báo cáo'],
        [
            'Ca sửa hoàn tất',
            n(snapshot.evidence?.completedRepairsCount),
            `${n(snapshot.evidence?.coveragePct)}% đủ ảnh`,
        ],
        ['Phiếu quá hạn', n(snapshot.maintenance?.overdueCount), 'Cần xử lý'],
        ['Vật tư dưới định mức', n(snapshot.inventory?.lowStockCount), 'Cần đối chiếu'],
        ['Chi phí vận hành', vnd(snapshot.cost?.total), `${n(snapshot.cost?.totalDeltaPct)}% so kỳ trước`],
    ];
    const startY = doc.y;
    kpis.forEach(([label, value, hint], index) => {
        const row = Math.floor(index / 3);
        const col = index % 3;
        const x = doc.page.margins.left + col * (width + gap);
        const y = startY + row * 64;
        doc.roundedRect(x, y, width, 56, 5).fillAndStroke(COLORS.soft, COLORS.line);
        doc.font('Noto')
            .fontSize(7.5)
            .fillColor(COLORS.muted)
            .text(label, x + 10, y + 8, { width: width - 20 });
        doc.font('NotoBold')
            .fontSize(14)
            .fillColor(COLORS.ink)
            .text(value, x + 10, y + 22, {
                width: width - 20,
                ellipsis: true,
            });
        doc.font('Noto')
            .fontSize(7)
            .fillColor(COLORS.muted)
            .text(hint, x + 10, y + 42, { width: width - 20 });
    });
    doc.y = startY + 134;
};

const drawLowStockTable = (doc: PDFKit.PDFDocument, items: any[]) => {
    const x = doc.page.margins.left;
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const widths = [totalWidth * 0.42, totalWidth * 0.23, totalWidth * 0.21, totalWidth * 0.14];
    const headers = ['Vật tư', 'Cơ sở', 'Tồn / định mức', 'Thiếu'];
    const rowHeight = 31;

    const header = () => {
        ensureSpace(doc, rowHeight * 2);
        const rowY = doc.y;
        let cursor = x;
        headers.forEach((headerText, index) => {
            doc.rect(cursor, rowY, widths[index], 24).fill(COLORS.ink);
            doc.font('NotoBold')
                .fontSize(7.5)
                .fillColor(COLORS.white)
                .text(headerText, cursor + 6, rowY + 8, {
                    width: widths[index] - 12,
                    align: index >= 2 ? 'right' : 'left',
                });
            cursor += widths[index];
        });
        doc.y = rowY + 24;
    };

    header();
    if (!items.length) {
        const rowY = doc.y;
        doc.rect(x, rowY, totalWidth, rowHeight).fillAndStroke(COLORS.soft, COLORS.line);
        doc.font('Noto')
            .fontSize(8.5)
            .fillColor(COLORS.muted)
            .text('Không có vật tư dưới định mức.', x + 8, rowY + 10);
        doc.y = rowY + rowHeight;
        return;
    }

    for (const item of items.slice(0, 12)) {
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 28) header();
        const rowY = doc.y;
        let cursor = x;
        const values = [
            `${text(item.materialName)}\n${text(item.materialCode)}`,
            text(item.plantName),
            `${n(item.currentStock)} / ${n(item.minStockLevel)} ${text(item.unit, '')}`,
            `${n(item.shortage)} ${text(item.unit, '')}`,
        ];
        values.forEach((value, index) => {
            doc.rect(cursor, rowY, widths[index], rowHeight).fillAndStroke(COLORS.white, COLORS.line);
            doc.font(index === 3 ? 'NotoBold' : 'Noto')
                .fontSize(7.5)
                .fillColor(index === 3 ? COLORS.red : COLORS.text)
                .text(value, cursor + 6, rowY + 7, {
                    width: widths[index] - 12,
                    height: rowHeight - 10,
                    align: index >= 2 ? 'right' : 'left',
                    ellipsis: true,
                });
            cursor += widths[index];
        });
        doc.y = rowY + rowHeight;
    }
};

const drawPlantPerformance = (doc: PDFKit.PDFDocument, items: any[]) => {
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    for (const item of items.slice(0, 12)) {
        ensureSpace(doc, 52);
        const y = doc.y;
        doc.roundedRect(doc.page.margins.left, y, width, 44, 5).fillAndStroke(COLORS.soft, COLORS.line);
        doc.font('NotoBold')
            .fontSize(9.5)
            .fillColor(COLORS.ink)
            .text(text(item.plantName), doc.page.margins.left + 10, y + 8, {
                width: width * 0.42,
            });
        doc.font('Noto')
            .fontSize(7.5)
            .fillColor(COLORS.muted)
            .text(
                `${n(item.activeMachines)}/${n(item.totalMachines)} máy hoạt động`,
                doc.page.margins.left + 10,
                y + 24,
                { width: width * 0.42 }
            );
        doc.font('NotoBold')
            .fontSize(13)
            .fillColor(COLORS.blue)
            .text(`${n(item.activeRate)}%`, doc.page.margins.left + width * 0.5, y + 8, {
                width: 55,
                align: 'right',
            });
        doc.font('Noto')
            .fontSize(7.5)
            .fillColor(COLORS.text)
            .text(
                `Hoàn tất: ${n(item.completedRepairs)}   Phiếu mở: ${n(item.openTickets)}   Thiếu VT: ${n(item.lowStockCount)}`,
                doc.page.margins.left + width * 0.64,
                y + 15,
                { width: width * 0.33, align: 'right' }
            );
        doc.y = y + 51;
    }
};

type RepairEvidenceItem = {
    item: any;
    before: Buffer | null;
    after: Buffer | null;
};

const drawEvidenceImage = (
    doc: PDFKit.PDFDocument,
    image: Buffer | null,
    label: string,
    x: number,
    y: number,
    width: number,
    height: number
) => {
    doc.rect(x, y, width, height).fillAndStroke('#EEF2F6', COLORS.line);
    let rendered = false;
    if (image) {
        try {
            doc.image(image, x + 1, y + 1, {
                fit: [width - 2, height - 2],
                align: 'center',
                valign: 'center',
            });
            rendered = true;
        } catch {
            rendered = false;
        }
    }
    if (!rendered) {
        doc.font('Noto')
            .fontSize(7)
            .fillColor(COLORS.muted)
            .text('Chưa có ảnh', x, y + height / 2 - 4, { width, align: 'center' });
    }
    doc.rect(x + 5, y + 5, 36, 13).fill('#29364B');
    doc.font('NotoBold')
        .fontSize(6)
        .fillColor(COLORS.white)
        .text(label, x + 5, y + 9, {
            width: 36,
            align: 'center',
            lineBreak: false,
        });
};

const drawRepairEvidence = (doc: PDFKit.PDFDocument, evidence: RepairEvidenceItem[]) => {
    if (!evidence.length) {
        doc.font('Noto').fontSize(9).fillColor(COLORS.muted).text('Chưa có ca sửa hoàn tất trong kỳ.');
        return;
    }

    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const gap = 10;
    const cardWidth = (totalWidth - gap) / 2;
    const cardHeight = 132;
    for (let index = 0; index < evidence.length; index += 2) {
        ensureSpace(doc, cardHeight + 10);
        const rowY = doc.y;
        for (let column = 0; column < 2; column += 1) {
            const entry = evidence[index + column];
            if (!entry) continue;
            const x = doc.page.margins.left + column * (cardWidth + gap);
            doc.roundedRect(x, rowY, cardWidth, cardHeight, 5).fillAndStroke(COLORS.soft, COLORS.line);
            const imageGap = 4;
            const imageWidth = (cardWidth - 16 - imageGap) / 2;
            drawEvidenceImage(doc, entry.before, 'TRƯỚC', x + 8, rowY + 8, imageWidth, 72);
            drawEvidenceImage(doc, entry.after, 'SAU', x + 8 + imageWidth + imageGap, rowY + 8, imageWidth, 72);

            doc.font('NotoBold')
                .fontSize(8.5)
                .fillColor(COLORS.ink)
                .text(text(entry.item.machineCode || entry.item.machineName), x + 9, rowY + 89, {
                    width: cardWidth - 18,
                    ellipsis: true,
                    lineBreak: false,
                });
            doc.font('Noto')
                .fontSize(7.2)
                .fillColor(COLORS.muted)
                .text(
                    `${text(entry.item.plantName)} · ${n(entry.item.resolutionDays, 1)} ngày · ${n(entry.item.machineCount || 1)} máy`,
                    x + 9,
                    rowY + 106,
                    { width: cardWidth - 18, ellipsis: true, lineBreak: false }
                );
        }
        doc.y = rowY + cardHeight + 10;
    }
};

export const renderDigestPdf = async (digest: Record<string, any>): Promise<Buffer> => {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 42, right: 42, bottom: 48, left: 42 },
        bufferPages: true,
        info: {
            Title: `Bản tin điều hành - ${text(digest.periodLabel || digest.periodKey)}`,
            Author: 'Hải Đăng Management System',
            Subject: 'Bản tin vận hành nội bộ',
        },
    });
    doc.registerFont('Noto', REGULAR_FONT);
    doc.registerFont('NotoBold', BOLD_FONT);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const completed = new Promise<Buffer>((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });

    const snapshot = applyDigestEditorial(digest.snapshot || {}, digest.editorial);
    const coverUrl = digest.visual?.coverImageUrl || snapshot.successfulRepairs?.[0]?.afterImages?.[0];
    const selectedRepairs = (snapshot.successfulRepairs || []).slice(0, 4);
    const [cover, logo, repairEvidence] = await Promise.all([
        fetchImage(coverUrl),
        getLogoBuffer(),
        Promise.all(
            selectedRepairs.map(async (item: any) => {
                const [before, after] = await Promise.all([
                    fetchImage(item.beforeImages?.[0]),
                    fetchImage(item.afterImages?.[0]),
                ]);
                return { item, before, after };
            })
        ),
    ]);

    doc.rect(0, 0, doc.page.width, 205).fill(COLORS.ink);
    if (cover) {
        try {
            doc.save();
            doc.opacity(0.52);
            doc.image(cover, doc.page.width - 245, 0, { fit: [245, 205], align: 'center', valign: 'center' });
            doc.restore();
        } catch {
            doc.restore();
        }
    }
    if (logo) doc.image(logo, 42, 24, { fit: [32, 32] });
    doc.font('NotoBold').fontSize(8).fillColor('#9DDABF').text('HẢI ĐĂNG MS', 82, 35);
    doc.font('NotoBold').fontSize(9).fillColor('#9DDABF').text('BẢN TIN ĐIỀU HÀNH', 42, 82);
    doc.font('NotoBold')
        .fontSize(25)
        .fillColor(COLORS.white)
        .text(text(digest.periodLabel || digest.periodKey), 42, 101, {
            width: 370,
        });
    doc.font('Noto')
        .fontSize(8)
        .fillColor('#D8E0EA')
        .text(
            `Phiên bản ${n(digest.version)}.${n(digest.contentRevision)}  ·  Phát hành ${new Date().toLocaleString('vi-VN')}`,
            42,
            166
        );
    doc.y = 224;

    drawKpis(doc, snapshot);
    drawSectionTitle(
        doc,
        '01',
        'Tóm tắt điều hành',
        'Nội dung đã được người có thẩm quyền kiểm tra trước khi phát hành.'
    );
    doc.font('Noto').fontSize(10).fillColor(COLORS.text).text(text(digest.narrative), { lineGap: 4 });
    doc.moveDown(1);
    doc.font('NotoBold').fontSize(9.5).fillColor(COLORS.green).text('Điểm nổi bật');
    doc.moveDown(0.35);
    drawBulletList(doc, digest.highlights || [], COLORS.green);
    doc.moveDown(0.5);
    doc.font('NotoBold').fontSize(9.5).fillColor(COLORS.red).text('Rủi ro cần chú ý');
    doc.moveDown(0.35);
    drawBulletList(doc, digest.alerts || [], COLORS.red);
    doc.moveDown(0.5);
    doc.font('NotoBold').fontSize(9.5).fillColor(COLORS.blue).text('Hành động đề xuất');
    doc.moveDown(0.35);
    drawBulletList(doc, digest.recommendations || [], COLORS.blue);

    doc.addPage();
    drawSectionTitle(
        doc,
        '02',
        'Sự cố và ca sửa nổi bật',
        'Danh sách chi tiết sau biên tập. KPI tổng vẫn giữ nguyên từ snapshot.'
    );
    if (!(snapshot.notableIncidents || []).length) {
        doc.font('Noto').fontSize(9).fillColor(COLORS.muted).text('Không có sự cố nổi bật được chọn để phát hành.');
    }
    for (const item of (snapshot.notableIncidents || []).slice(0, 8)) {
        ensureSpace(doc, 45);
        doc.font('NotoBold')
            .fontSize(9)
            .fillColor(COLORS.ink)
            .text(`${text(item.machineCode || item.machineName)} · ${text(item.plantName)}`);
        doc.font('Noto').fontSize(8.3).fillColor(COLORS.text).text(text(item.description), { lineGap: 2 });
        doc.moveDown(0.6);
    }
    doc.moveDown(0.5);
    doc.font('NotoBold').fontSize(10).fillColor(COLORS.green).text('Ca sửa hoàn tất');
    doc.moveDown(0.4);
    drawRepairEvidence(doc, repairEvidence);

    doc.addPage();
    drawSectionTitle(doc, '03', 'Vật tư cần bổ sung', 'Các dòng tồn kho bằng hoặc dưới định mức sau biên tập.');
    drawLowStockTable(doc, snapshot.inventory?.lowStock || []);
    doc.moveDown(1.2);
    drawSectionTitle(
        doc,
        '04',
        'Hiệu quả theo cơ sở',
        'Số liệu xác định từ máy và phiếu bảo trì, không dùng điểm AI tự tạo.'
    );
    drawPlantPerformance(doc, snapshot.plantPerformance || []);

    const sourceWarnings = digest.dataWarnings?.length ? digest.dataWarnings : snapshot.dataWarnings || [];
    if (sourceWarnings.length) {
        doc.moveDown(0.5);
        drawSectionTitle(doc, '05', 'Giới hạn dữ liệu');
        drawBulletList(doc, sourceWarnings, COLORS.amber);
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
        doc.switchToPage(index);
        const footerY = doc.page.height - doc.page.margins.bottom - 12;
        doc.moveTo(doc.page.margins.left, footerY - 7)
            .lineTo(doc.page.width - doc.page.margins.right, footerY - 7)
            .strokeColor(COLORS.line)
            .stroke();
        doc.font('Noto')
            .fontSize(7)
            .fillColor(COLORS.muted)
            .text('Tài liệu nội bộ · Hải Đăng Management System', doc.page.margins.left, footerY, {
                width: 300,
            });
        doc.text(`Trang ${index + 1}/${range.count}`, doc.page.width - doc.page.margins.right - 90, footerY, {
            width: 90,
            align: 'right',
        });
    }

    doc.end();
    return completed;
};

const uploadPdf = (buffer: Buffer, publicId: string) =>
    new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'raw',
                type: 'authenticated',
                public_id: publicId,
                // publicId chứa checksum nội dung nên retry chỉ ghi lại đúng cùng một artifact.
                overwrite: true,
                tags: ['executive-digest', 'official-pdf'],
            },
            (error, result) => {
                if (error || !result) reject(error || new Error('Cloudinary did not return an upload result'));
                else resolve(result);
            }
        );
        stream.end(buffer);
    });

export const createDigestPdfArtifact = async (digest: Record<string, any>) => {
    const checksum = getDigestChecksum(digest);
    const version = Number(digest.version || 1);
    const contentRevision = Number(digest.contentRevision || 0);
    const baseName = `${text(digest.periodKey, 'digest')}-v${version}-r${contentRevision}-${checksum.slice(0, 10)}`;
    const fileName = `ban-tin-dieu-hanh-${baseName}.pdf`;
    const buffer = await renderDigestPdf(digest);
    const publicId = `hai-dang/executive-digests/official/${baseName}.pdf`;
    const uploaded = await uploadPdf(buffer, publicId);

    return {
        status: 'ready' as const,
        publicId: uploaded.public_id || publicId,
        fileName,
        checksum,
        bytes: buffer.length,
        version,
        contentRevision,
        generatedAt: new Date(),
    };
};

export const downloadDigestPdf = async (artifact: Record<string, any>): Promise<Buffer> => {
    if (!artifact?.publicId || artifact.status !== 'ready') throw new Error('Official PDF is not available');
    const signedUrl = cloudinary.url(artifact.publicId, {
        resource_type: 'raw',
        type: 'authenticated',
        secure: true,
        sign_url: true,
    });
    const response = await axios.get<ArrayBuffer>(signedUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 30 * 1024 * 1024,
    });
    return Buffer.from(response.data);
};
