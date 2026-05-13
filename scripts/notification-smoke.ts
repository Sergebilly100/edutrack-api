import 'dotenv/config';

import { defaultEmailSender, defaultSmsSender } from '../src/modules/notifications/notifications.service.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const schemaName = process.env.SMOKE_SCHEMA_NAME?.trim() || 'smoke';
  const smsTo = required('SMOKE_SMS_TO');
  const emailTo = required('SMOKE_EMAIL_TO');
  const timestamp = new Date().toISOString();

  const sms = await defaultSmsSender({
    to: smsTo,
    message: `EduTrack test SMS ${timestamp}`,
    type: 'custom',
    schemaName,
  });

  const email = await defaultEmailSender({
    to: emailTo,
    subject: `EduTrack test email ${timestamp}`,
    text: `Test email EduTrack envoyé le ${timestamp}.`,
    type: 'custom',
    schemaName,
  });

  console.log(JSON.stringify({ sms, email }, null, 2));

  if (sms.status !== 'sent' || email.status !== 'sent') {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
