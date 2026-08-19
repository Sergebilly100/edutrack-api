import { emit } from '../../shared/events/event-bus.js';
import type { EnrollmentDocumentsMissingPayload } from '../../shared/events/events.types.js';

export const emitEnrollmentDocumentsMissing = (
  payload: EnrollmentDocumentsMissingPayload
): void => {
  emit('enrollment.documents_missing', payload);
};
