import { IsoBmffError } from '../../src/core/isobmff/boxes.ts';

// @ts-expect-error
export const withoutCode = new IsoBmffError('corrupt file: a message alone');

export const withCode = new IsoBmffError('corrupt', 'corrupt file: a message with its code');
