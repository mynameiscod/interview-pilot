import { CreditEntryType, CreditLotSource } from '@cbi/shared-types';
import type {
  CreditEntryType as CreditEntryTypeT,
  CreditLotSource as CreditLotSourceT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

/**
 * One immutable credit movement. `amount` changes the available balance;
 * `reservedDelta` changes the reserved balance. A grant creates a lot
 * (`lotId` = its own id); spending and refunds name the lot they touch.
 */
export interface CreditLedgerRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: CreditEntryTypeT;
  amount: number;
  reservedDelta: number;
  lotId: Types.ObjectId | null;
  /** Grants only: the lot's origin and expiry. */
  lotSource: CreditLotSourceT | null;
  expiresAt: Date | null;
  refType: string | null;
  refId: string | null;
  /** Unique: the same business event can never be written twice. */
  idempotencyKey: string;
  actorId: Types.ObjectId | null;
  reason: string | null;
  createdAt: Date;
}

const ledgerSchema = new Schema<CreditLedgerRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: CreditEntryType.options, required: true },
    amount: { type: Number, required: true },
    reservedDelta: { type: Number, required: true, default: 0 },
    lotId: { type: Schema.Types.ObjectId, default: null },
    lotSource: { type: String, enum: [...CreditLotSource.options, null], default: null },
    expiresAt: { type: Date, default: null },
    refType: { type: String, default: null },
    refId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'creditLedger' },
);
ledgerSchema.index({ idempotencyKey: 1 }, { unique: true });
ledgerSchema.index({ userId: 1, createdAt: -1 });
ledgerSchema.index({ lotId: 1 });
ledgerSchema.index({ type: 1, expiresAt: 1 });
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  ledgerSchema.pre(op, function () {
    throw new Error('creditLedger is append-only');
  });
}

export const CreditLedgerModel = model<CreditLedgerRecord>('CreditLedger', ledgerSchema);

export interface CreditLotRecord {
  lotId: Types.ObjectId;
  source: CreditLotSourceT;
  remaining: number;
  expiresAt: Date | null;
}

/** Projection of the ledger, updated in the same transaction as every ledger insert. */
export interface CreditAccountRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  balance: number;
  reserved: number;
  lots: CreditLotRecord[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const accountSchema = new Schema<CreditAccountRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    balance: { type: Number, required: true, default: 0, min: 0 },
    reserved: { type: Number, required: true, default: 0, min: 0 },
    lots: {
      type: [
        new Schema<CreditLotRecord>(
          {
            lotId: { type: Schema.Types.ObjectId, required: true },
            source: { type: String, enum: CreditLotSource.options, required: true },
            remaining: { type: Number, required: true, min: 0 },
            expiresAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: 'creditAccounts' },
);
accountSchema.index({ userId: 1 }, { unique: true });

export const CreditAccountModel = model<CreditAccountRecord>('CreditAccount', accountSchema);
