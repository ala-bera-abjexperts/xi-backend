/**
 * @fileoverview Jest global setup that silences NestJS Logger output during tests.
 * This prevents ERROR/WARN log noise from expected error-path test cases
 * while keeping the test output clean and readable.
 * @module src/test/jest-setup
 * @author Prince Jadiya
 */

import { Logger } from '@nestjs/common';

// Disable all NestJS Logger output during test runs
Logger.overrideLogger([]);
