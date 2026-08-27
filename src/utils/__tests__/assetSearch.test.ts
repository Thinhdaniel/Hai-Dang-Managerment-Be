import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetSearchConditions, tokenizeAssetSearch } from '@/utils/assetSearch';

const matchesAsset = (asset: Record<string, unknown>, search: string) =>
    buildAssetSearchConditions(search).every((condition) =>
        condition.$or.some((fieldCondition) =>
            Object.entries(fieldCondition).some(([field, regex]) => regex.test(String(asset[field] ?? '')))
        )
    );

test('chuẩn hóa dấu ngoặc nhưng giữ nguyên token mã máy', () => {
    assert.deepEqual(tokenizeAssetSearch('  2 kim (móc xích)  '), ['2', 'kim', 'móc', 'xích']);
    assert.deepEqual(tokenizeAssetSearch('2KMX-JUKI-HD-006'), ['2KMX-JUKI-HD-006']);
});

test('khớp tên có dấu ngoặc giống cách trợ lý AI lọc theo từng token', () => {
    assert.equal(
        matchesAsset(
            {
                name: 'Máy 2 kim (móc xích)',
                machineCode: '2K-SIRUBA-HD-008',
                serial: '170224002',
            },
            '2 kim móc xích'
        ),
        true
    );
});

test('cho phép các token khớp trên nhiều trường máy khác nhau', () => {
    assert.equal(
        matchesAsset(
            {
                name: 'Máy 2k móc xích',
                machineCode: '2K-JUKI-HD-001',
                type: 'Máy 2 kim',
            },
            '2 kim móc xích'
        ),
        true
    );
});

test('không trả máy thiếu một token bắt buộc', () => {
    assert.equal(
        matchesAsset(
            {
                name: 'Máy 2 kim thắt nút',
                machineCode: '2KTN-JUKI-HD-001',
                type: 'Máy 2 kim',
            },
            '2 kim móc xích'
        ),
        false
    );
});
