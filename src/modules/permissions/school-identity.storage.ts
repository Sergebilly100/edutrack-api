import {
  deleteFromR2,
  isR2Configured,
  keyFromPublicUrl,
  readR2Buffer,
  uploadBuffer,
  uploadToR2,
} from '../../shared/storage/r2.js';

import type { IdentityStorage } from './school-identity.service.js';

/** Stockage R2 : objets du cachet-signature privés (clé seule), logo servi par URL publique existante. */
export const r2IdentityStorage: IdentityStorage = {
  isConfigured: isR2Configured,
  putPrivate: async (key, body, contentType) => {
    await uploadBuffer(key, body, contentType);
  },
  putPublic: async (key, body, contentType) => (await uploadToR2(key, body, contentType)).url,
  read: readR2Buffer,
  remove: deleteFromR2,
  keyFromPublicUrl,
};
