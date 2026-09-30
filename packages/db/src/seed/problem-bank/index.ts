import { ARRAYS_HASHING } from './arrays-hashing.js';
import { HEAPS_INTERVALS_DP } from './heaps-intervals-dp.js';
import { SQL } from './sql.js';
import { STACKS_QUEUES } from './stacks-queues.js';
import { TREES_GRAPHS } from './trees-graphs.js';
import { TWO_POINTERS_WINDOWS } from './two-pointers-windows.js';
import type { SeedProblem } from './types.js';

export type { SeedProblem } from './types.js';

/** Every seeded problem (40: 13 easy, 17 medium, 10 hard; 4 of them SQL). */
export const PROBLEM_BANK: readonly SeedProblem[] = [
  ...ARRAYS_HASHING,
  ...TWO_POINTERS_WINDOWS,
  ...STACKS_QUEUES,
  ...TREES_GRAPHS,
  ...HEAPS_INTERVALS_DP,
  ...SQL,
];
