import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.hoisted(() => vi.fn());

vi.mock('../../src/shared/database/db.js', () => ({
  db: {
    execute: dbExecute,
  },
  withTenantSchema: vi.fn(),
}));

describe('defaultSmsSender', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env.SMS_MOCK = 'false';
    delete process.env.AFRICASTALKING_API_KEY;
    delete process.env.AFRICASTALKING_USERNAME;
    delete process.env.AFRICASTALKING_BASE_URL;
    delete process.env.ORANGE_CLIENT_ID;
    delete process.env.ORANGE_CLIENT_SECRET;
    delete process.env.ORANGE_SENDER_ADDRESS;
    delete process.env.ORANGE_SENDER_NAME;
    delete process.env.ORANGE_SMS_BASE_URL;
    delete process.env.ORANGE_TOKEN_URL;
  });

  it("envoie via Africa's Talking quand le provider est configuré", async () => {
    process.env.AFRICASTALKING_USERNAME = 'edutrack';
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          sms_provider: 'africas_talking',
          sms_api_base_url: 'https://api.sandbox.africastalking.com/version1/messaging',
          sms_api_key: 'at-secret',
          sms_sender_id: 'EduTrack',
          sms_maintenance_mode: false,
          sms_maintenance_message: null,
        },
      ],
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        SMSMessageData: {
          Message: 'Sent to 1/1 Total Cost: XOF 10',
          Recipients: [
            {
              number: '+2250700000001',
              status: 'Success',
              statusCode: 102,
              messageId: 'ATXid_test',
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { defaultSmsSender } = await import('../../src/modules/notifications/notifications.service.js');
    const result = await defaultSmsSender({
      to: '0700000001',
      message: 'Test EduTrack',
      type: 'student_absent_parent',
      schemaName: 'school_demo',
    });

    expect(result).toEqual({ status: 'sent', providerRef: 'ATXid_test' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(init.headers).toMatchObject({
      apiKey: 'at-secret',
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = init.body as URLSearchParams;
    expect(body.get('username')).toBe('edutrack');
    expect(body.get('to')).toBe('+2250700000001');
    expect(body.get('message')).toBe('Test EduTrack');
    expect(body.get('from')).toBe('EduTrack');
    expect(body.get('enqueue')).toBe('1');
  });

  it("échoue clairement si l'identifiant Africa's Talking manque", async () => {
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          sms_provider: 'africas_talking',
          sms_api_base_url: null,
          sms_api_key: 'at-secret',
          sms_sender_id: 'EduTrack',
          sms_maintenance_mode: false,
          sms_maintenance_message: null,
        },
      ],
    });

    const { defaultSmsSender } = await import('../../src/modules/notifications/notifications.service.js');
    const result = await defaultSmsSender({
      to: '+2250700000001',
      message: 'Test EduTrack',
      type: 'student_absent_parent',
      schemaName: 'school_demo',
    });

    expect(result).toEqual({
      status: 'failed',
      errorMessage: 'Missing Africa’s Talking API key or username',
    });
  });

  it("envoie via l'endpoint bulk Africa's Talking avec un payload JSON", async () => {
    process.env.AFRICASTALKING_USERNAME = 'edutrack';
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          sms_provider: 'africas_talking',
          sms_api_base_url: 'https://api.africastalking.com/version1/messaging/bulk',
          sms_api_key: 'at-secret',
          sms_sender_id: '',
          sms_maintenance_mode: false,
          sms_maintenance_message: null,
        },
      ],
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        SMSMessageData: {
          Message: 'Sent to 1/1 Total Cost: XOF 10',
          Recipients: [
            {
              number: '+2250700000001',
              status: 'Success',
              statusCode: 102,
              messageId: 'ATXid_bulk_test',
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { defaultSmsSender } = await import('../../src/modules/notifications/notifications.service.js');
    const result = await defaultSmsSender({
      to: '0700000001',
      message: 'Test EduTrack bulk',
      type: 'student_absent_parent',
      schemaName: 'school_demo',
    });

    expect(result).toEqual({ status: 'sent', providerRef: 'ATXid_bulk_test' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.africastalking.com/version1/messaging/bulk');
    expect(init.headers).toMatchObject({
      apiKey: 'at-secret',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      username: 'edutrack',
      message: 'Test EduTrack bulk',
      phoneNumbers: ['+2250700000001'],
    });
  });

  it('envoie via smsmode quand le provider smsmode est configuré', async () => {
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          sms_provider: 'smsmode',
          sms_api_base_url: 'https://rest.smsmode.com/sms/v1',
          sms_api_key: 'smsmode-secret',
          sms_sender_id: 'EduTrack',
          sms_fallback_sender_id: null,
          sms_maintenance_mode: false,
          sms_maintenance_message: null,
        },
      ],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ messageId: 'smsmode-ref-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { defaultSmsSender } = await import('../../src/modules/notifications/notifications.service.js');
    const result = await defaultSmsSender({
      to: '+2250787380274',
      message: 'Test EduTrack smsmode',
      type: 'student_absent_parent',
      schemaName: 'school_demo',
    });

    expect(result).toEqual({ status: 'sent', providerRef: 'smsmode-ref-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://rest.smsmode.com/sms/v1/messages');
    expect(init.headers).toMatchObject({
      'X-Api-Key': 'smsmode-secret',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { to: '+2250787380274' },
      body: { text: 'Test EduTrack smsmode' },
      from: 'EduTrack',
    });
  });
});
