import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor default to 1 s. The first test in a file also pays for transforming lazily
// loaded pages, which can take several seconds when turbo runs every suite in parallel.
configure({ asyncUtilTimeout: 15_000 });

afterEach(() => cleanup());
