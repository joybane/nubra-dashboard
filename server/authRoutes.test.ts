import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerAuthRoutes } from './authRoutes.ts';

let app: ReturnType<typeof Fastify>;
let authState: {
  deviceId: string;
  tempToken: string | null;
  authToken: string | null;
  sessionToken: string | null;
  mpin: string | null;
  phone: string | null;
  salt: string | null;
  status: 'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated';
};
const nubraPost = vi.fn(async () => ({}));
const saveSession = vi.fn();
const connectNubraWs = vi.fn();
const broadcast = vi.fn();
const performLogout = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  authState = {
    deviceId: 'test-device',
    tempToken: null,
    authToken: null,
    sessionToken: null,
    mpin: null,
    phone: null,
    salt: null,
    status: 'idle',
  };
  app = Fastify();
  registerAuthRoutes({
    fastify: app,
    authState,
    nubraPost,
    saveSession,
    connectNubraWs,
    broadcast,
    performLogout,
    getDefaultPhone: () => undefined,
    getDefaultMpin: () => undefined,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

test('registers every existing authentication endpoint', () => {
  expect(app.hasRoute({ method: 'POST', url: '/auth/send-otp' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/auth/verify-otp' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/auth/verify-pin' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/auth/status' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/auth/logout' })).toBe(true);
});

test('preserves authentication status response shape', async () => {
  authState.status = 'authenticated';

  const response = await app.inject({ method: 'GET', url: '/auth/status' });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'authenticated', authenticated: true });
});

test('preserves send-otp validation before broker work', async () => {
  const response = await app.inject({ method: 'POST', url: '/auth/send-otp', payload: {} });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'Phone number is required.' });
  expect(nubraPost).not.toHaveBeenCalled();
});

test('preserves send-otp state transition and broker payload', async () => {
  nubraPost.mockResolvedValueOnce({ temp_token: 'temporary-token', next: 'VERIFY_OTP' });

  const response = await app.inject({
    method: 'POST',
    url: '/auth/send-otp',
    payload: { phone: ' 9999999999 ' },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, message: 'OTP sent to registered mobile number.' });
  expect(nubraPost).toHaveBeenCalledWith('/sendphoneotp', {
    phone: '9999999999',
    flow: '',
    skip_totp: false,
  });
  expect(authState.tempToken).toBe('temporary-token');
  expect(authState.phone).toBe('9999999999');
  expect(authState.status).toBe('awaiting_otp');
  expect(saveSession).toHaveBeenCalledOnce();
});

test('preserves verify-otp validation before broker work', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/verify-otp',
    payload: { otp: '' },
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'OTP required.' });
  expect(nubraPost).not.toHaveBeenCalled();
});

test('preserves logout delegation and response', async () => {
  const response = await app.inject({ method: 'POST', url: '/auth/logout' });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(performLogout).toHaveBeenCalledOnce();
});
