// SPDX-License-Identifier: AGPL-3.0-only
// node:stream/promises on readable-stream.

import { promises } from 'stream';

export const { pipeline, finished } = promises;
export default promises;
