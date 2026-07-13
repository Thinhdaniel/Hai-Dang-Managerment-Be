import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Asset from '../src/models/Asset';
import Material from '../src/models/Material';
import Plant from '../src/models/Plant';
import { USER_ROLE } from '../src/constant/allowedRoles';
import connectDB from '../src/config/database.config';
import { routeAssistantQuestion, runAssistant } from '../src/services/ai-agent.service';

const main = async () => {
    await connectDB();
    const asset: any = await Asset.findOne({
        isDeleted: { $ne: true },
        machineCode: { $regex: /^(?=.*[A-Za-z])(?=.*\d).+[-_].+$/ },
    })
        .select('machineCode plantId')
        .lean();
    assert.ok(asset?.machineCode, 'Cần ít nhất một máy có mã để chạy action smoke test');
    const plant: any = asset.plantId ? await Plant.findById(asset.plantId).select('name').lean() : null;

    const question = `Tạo phiếu bảo trì máy ${asset.machineCode}, lỗi bỏ mũi, sửa nội bộ.`;
    assert.equal(routeAssistantQuestion(question)?.tool, 'draft_maintenance');
    const result: any = await runAssistant(
        [
            {
                role: 'user',
                content: question,
            },
        ],
        {
            userId: '000000000000000000000001',
            role: USER_ROLE.ADMIN,
            plantId: String(asset.plantId || ''),
            plantName: plant?.name,
            permissions: [],
            canAccessProcurement: true,
        },
        undefined,
        { skipTrace: true }
    );

    assert.equal(result.provider, 'heuristic');
    assert.equal(result.actions?.length, 1);
    assert.equal(result.actions[0].type, 'maintenance_draft');
    assert.equal(result.actions[0].requiresConfirmation, true);
    assert.equal(result.actions[0].payload.assetIds.length, 1);
    assert.equal(result.actions[0].targetPath, '/maintenances');

    if (process.argv.includes('--with-provider')) {
        const material: any =
            (await Material.findOne({ isDeleted: { $ne: true }, isActive: { $ne: false }, name: /giấy a4/i })
                .select('name unit')
                .lean()) ||
            (await Material.findOne({ isDeleted: { $ne: true }, isActive: { $ne: false } })
                .select('name unit')
                .lean());
        assert.ok(material?.name, 'Cần ít nhất một vật tư để chạy provider action smoke test');
        const assistantContext = {
            userId: '000000000000000000000001',
            role: USER_ROLE.ADMIN,
            plantId: String(asset.plantId || ''),
            plantName: plant?.name,
            permissions: [],
            canAccessProcurement: true,
        };
        const supply: any = await runAssistant(
            [
                {
                    role: 'user',
                    content: `Tạo đề xuất cấp 2 ${material.unit} ${material.name}, mục đích kiểm tra vận hành.`,
                },
            ],
            assistantContext,
            undefined,
            { skipTrace: true }
        );
        assert.equal(supply.actions?.[0]?.type, 'supply_request_draft');
        assert.equal(supply.actions[0].payload.items.length, 1);

        const purchase: any = await runAssistant(
            [
                {
                    role: 'user',
                    content: `Soạn đề xuất mua 3 ${material.unit} ${material.name}, mục đích bổ sung tồn kho.`,
                },
            ],
            assistantContext,
            undefined,
            { skipTrace: true }
        );
        assert.equal(purchase.actions?.[0]?.type, 'purchase_request_draft');
        assert.equal(purchase.actions[0].payload.items.length, 1);
        console.log('AI guided material actions with provider: OK');
    }
    console.log('AI guided action smoke: OK');
};

main()
    .then(async () => {
        await mongoose.disconnect();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(error);
        await mongoose.disconnect();
        process.exit(1);
    });
