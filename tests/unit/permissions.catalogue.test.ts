import { describe, expect, it } from 'vitest';
import { buildPermissionCatalogue } from '../../src/modules/permissions/permissions.catalogue.js';
import { PERMISSION_KEYS } from '../../src/modules/permissions/permissions.types.js';

describe('catalogue de permissions', () => {
  for (const canEditSmsTemplate of [false, true]) {
    for (const smsEnabled of [false, true]) {
      for (const monetizeParentAlerts of [false, true]) {
        it(`reste exhaustif avec les services ${canEditSmsTemplate}/${smsEnabled}/${monetizeParentAlerts}`, () => {
          const catalogue = buildPermissionCatalogue({ canEditSmsTemplate, smsEnabled, monetizeParentAlerts });
          expect(catalogue.version).toBe(1);
          expect(catalogue.permissions.map((entry) => entry.key)).toEqual(PERMISSION_KEYS);
          expect(new Set(catalogue.permissions.map((entry) => entry.key)).size).toBe(PERMISSION_KEYS.length);
          for (const entry of catalogue.permissions) {
            expect(entry.label.length).toBeGreaterThan(0);
            expect(entry.domainLabel.length).toBeGreaterThan(0);
            expect(entry.available).toBe(entry.activationDependencies.every((dependency) => dependency.enabled));
            if (!entry.available) expect(entry.unavailableReason).toBeTruthy();
            for (const required of entry.requiredPermissions) expect(PERMISSION_KEYS).toContain(required);
            if (entry.key === 'settings.sms_templates') expect(entry.available).toBe(canEditSmsTemplate);
            if (entry.key.startsWith('subscriptions.')) expect(entry.available).toBe(smsEnabled && monetizeParentAlerts);
            if (entry.key === 'report_cards.published_correction') {
              expect(entry.requiredPermissions).toEqual(['report_cards.view', 'report_cards.publish']);
              expect(entry.available).toBe(true);
              expect(entry.unavailableReason).toBeNull();
            }
          }
        });
      }
    }
  }
});
