import { afterAll, afterEach, beforeAll } from 'vitest';
import { startTestApp, stopTestApp, truncateAttendanceTables } from '../support/school-harness.js';

export * from '../support/school-harness.js';

beforeAll(startTestApp);
afterEach(truncateAttendanceTables);
afterAll(stopTestApp);
