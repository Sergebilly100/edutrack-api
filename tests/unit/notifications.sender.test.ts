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

  it("envoie via Orange API quand le provider orange_api est configuré", async () => {
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          sms_provider: 'orange_api',
          sms_api_base_url: 'https://api.orange.com/smsmessaging/v1/outbound',
          sms_api_key: 'orange-client:orange-secret',
          sms_sender_id: '+2250700000002',
          sms_fallback_sender_id: 'EduTrack',
          sms_maintenance_mode: false,
          sms_maintenance_message: null,
        },
      ],
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'orange-token', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            outboundSMSMessageRequest: {
              resourceURL: 'https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B2250700000002/requests/ref-1',
            },
          }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { defaultSmsSender } = await import('../../src/modules/notifications/notifications.service.js');
    const result = await defaultSmsSender({
      to: '0700000001',
      message: 'Test EduTrack Orange',
      type: 'student_absent_parent',
      schemaName: 'school_demo',
    });

    expect(result).toEqual({
      status: 'sent',
      providerRef:
        'https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B2250700000002/requests/ref-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe('https://api.orange.com/oauth/v3/token');
    expect(tokenInit.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('orange-client:orange-secret').toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(tokenInit.body).toBe('grant_type=client_credentials');

    const [smsUrl, smsInit] = fetchMock.mock.calls[1]!;
    expect(smsUrl).toBe(
      'https://api.orange.com/smsmessaging/v1/outbound/tel%3A%2B2250700000002/requests'
    );
    expect(smsInit.headers).toMatchObject({
      Authorization: 'Bearer orange-token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(smsInit.body as string)).toEqual({
      outboundSMSMessageRequest: {
        address: 'tel:+2250700000001',
        senderAddress: 'tel:+2250700000002',
        outboundSMSTextMessage: {
          message: 'Test EduTrack Orange',
        },
        senderName: 'EduTrack',
      },
    });
  });
});
