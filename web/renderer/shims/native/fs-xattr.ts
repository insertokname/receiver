// SPDX-License-Identifier: AGPL-3.0-only
// fs-xattr (extended file attributes, macOS): there are no files to tag.

import { unavailable } from '../node/unavailable.ts';

const name = 'fs-xattr';
export const getAttribute = unavailable(name, 'getAttribute');
export const setAttribute = unavailable(name, 'setAttribute');
export const removeAttribute = unavailable(name, 'removeAttribute');
export const listAttributes = unavailable(name, 'listAttributes');
export default { getAttribute, setAttribute, removeAttribute, listAttributes };
