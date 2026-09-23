import type { MeResponse } from '@cbi/shared-types';
import { useAuth } from '@cbi/web-core';

export const useCandidateAuth = () => useAuth<MeResponse>();
