import { DuplicateError, NotFoundError } from '@/errors/customError';
import Supplier from '@/models/Supplier';
import { supplierRepository } from '@/repositories/supplier.repository';
import customResponse from '@/utils/response';
import { buildSearchRegex } from '@/utils/search';
import { serializeSupplier } from '@/utils/materialSerializers';
import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';

const ensureSupplierCodeAvailable = async (code?: string, excludeId?: string) => {
    const normalizedCode = code?.trim();

    if (!normalizedCode) {
        return;
    }

    const existingSupplier = await Supplier.findOne({
        code: normalizedCode,
        isDeleted: { $ne: true },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
        .select('_id code')
        .lean();

    if (existingSupplier) {
        throw new DuplicateError('Ma nha cung cap da ton tai');
    }
};

const normalizeSupplyTypes = (supplyTypes?: string[]) => {
    const normalizedSupplyTypes = new Set([...(supplyTypes ?? []), 'material']);
    return Array.from(normalizedSupplyTypes);
};

const buildSupplierFilter = (query: Request['query']) => {
    const filter: Record<string, any> = {
        isDeleted: { $ne: true },
        supplyTypes: 'material',
    };

    const regex = buildSearchRegex(query.search, { flexibleWhitespace: true });

    if (regex) {
        filter.$or = [{ name: regex }, { code: regex }, { contactName: regex }, { phone: regex }];
    }

    if (query.isActive != null) {
        filter.isActive = String(query.isActive) === 'true';
    }

    return filter;
};

export const getAllMaterialSuppliers = async (req: Request, res: Response, next: NextFunction) => {
    const suppliers = await supplierRepository.findMany(buildSupplierFilter(req.query), { sort: 'name' });

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: suppliers.map(serializeSupplier),
            message: 'Lay danh sach nha cung cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};

export const createMaterialSupplier = async (req: Request, res: Response, next: NextFunction) => {
    await ensureSupplierCodeAvailable(req.body.code);

    const supplier = await supplierRepository.create({
        ...req.body,
        code: req.body.code?.trim() || undefined,
        supplyTypes: normalizeSupplyTypes(req.body.supplyTypes),
        createdBy: req.userId,
        updatedBy: req.userId,
    });

    const createdSupplier = await supplierRepository.findById(String(supplier._id));

    return res.status(StatusCodes.CREATED).json(
        customResponse({
            data: serializeSupplier(createdSupplier),
            message: 'Tao nha cung cap vat tu thanh cong',
            status: StatusCodes.CREATED,
            success: true,
        })
    );
};

export const updateMaterialSupplier = async (req: Request, res: Response, next: NextFunction) => {
    await ensureSupplierCodeAvailable(req.body.code, String(req.params.id));

    const supplier = await supplierRepository.updateById(String(req.params.id), {
        ...req.body,
        code: req.body.code?.trim() || undefined,
        supplyTypes: req.body.supplyTypes ? normalizeSupplyTypes(req.body.supplyTypes) : undefined,
        updatedBy: req.userId,
    });

    if (!supplier) {
        throw new NotFoundError('Khong tim thay nha cung cap');
    }

    return res.status(StatusCodes.OK).json(
        customResponse({
            data: serializeSupplier(supplier),
            message: 'Cap nhat nha cung cap vat tu thanh cong',
            status: StatusCodes.OK,
            success: true,
        })
    );
};
