import {
  DesignAttemptModel,
  DesignPromptModel,
  type DesignAttemptRecord,
  type DesignPromptRecord,
} from '@cbi/db';
import type { Types } from 'mongoose';

/** System design rounds in evaluation: the designs of a session and their prompts. */
export interface DesignContext {
  attempts: DesignAttemptRecord[];
  prompts: Map<string, DesignPromptRecord>;
}

export async function loadDesign(sessionId: Types.ObjectId): Promise<DesignContext> {
  const attempts = await DesignAttemptModel.find({ sessionId })
    .sort({ roundIdx: 1 })
    .lean<DesignAttemptRecord[]>();
  const prompts = attempts.length
    ? await DesignPromptModel.find({
        _id: { $in: attempts.map((a) => a.promptId) },
      }).lean<DesignPromptRecord[]>()
    : [];
  return { attempts, prompts: new Map(prompts.map((p) => [String(p._id), p])) };
}

/** A design with anything in it (notes or boxes). */
export const hasDesign = (a: Pick<DesignAttemptRecord, 'notes' | 'diagram'>) =>
  a.diagram.nodes.length > 0 || Object.values(a.notes).some((v) => v.trim() !== '');
