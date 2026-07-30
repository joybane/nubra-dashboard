import type { FastifyInstance } from 'fastify';

type AuthStatus = 'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated';

interface AuthState {
  deviceId: string;
  tempToken: string | null;
  authToken: string | null;
  sessionToken: string | null;
  mpin: string | null;
  phone: string | null;
  salt: string | null;
  status: AuthStatus;
}

type NubraPost = (
  endpoint: string,
  body: object,
  extraHeaders?: Record<string, string>,
) => Promise<Record<string, unknown>>;

interface AuthRouteDeps {
  fastify: FastifyInstance;
  authState: AuthState;
  nubraPost: NubraPost;
  saveSession: () => void;
  connectNubraWs: () => void;
  broadcast: (message: unknown) => void;
  performLogout: () => void;
  getDefaultPhone: () => string | undefined;
  getDefaultMpin: () => string | undefined;
}

export function registerAuthRoutes({
  fastify,
  authState,
  nubraPost,
  saveSession,
  connectNubraWs,
  broadcast,
  performLogout,
  getDefaultPhone,
  getDefaultMpin,
}: AuthRouteDeps): void {
  // ─── Auth endpoints ───────────────────────────────────────────────────────────
  fastify.post<{ Body: { phone?: string } }>('/auth/send-otp', async (req, reply) => {
    try {
      const phone = req.body?.phone || authState.phone || getDefaultPhone();
      if (!phone) return reply.status(400).send({ ok: false, error: 'Phone number is required.' });

      const cleanPhone = phone.trim();
      const data = await nubraPost('/sendphoneotp', {
        phone: cleanPhone,
        flow: '',
        skip_totp: false,
      });
      let tempToken = data.temp_token as string;
      const next = data.next as string;

      if (!tempToken) throw new Error('temp_token missing in response');

      if (next === 'VERIFY_TOTP') {
        const data2 = await nubraPost(
          '/sendphoneotp',
          { phone: cleanPhone, flow: '', skip_totp: true },
          { 'x-temp-token': tempToken },
        );
        tempToken = data2.temp_token as string;
        if (!tempToken) throw new Error('temp_token missing in skip_totp response');
      }

      authState.tempToken = tempToken;
      authState.phone = cleanPhone;
      authState.status = 'awaiting_otp';
      saveSession();
      return reply.send({ ok: true, message: 'OTP sent to registered mobile number.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: msg });
    }
  });

  fastify.post<{ Body: { otp: string; mpin?: string } }>('/auth/verify-otp', async (req, reply) => {
    try {
      const { otp, mpin } = req.body;
      if (!otp) return reply.status(400).send({ ok: false, error: 'OTP required.' });
      if (!authState.tempToken)
        return reply.status(400).send({ ok: false, error: 'Send OTP first.' });
      if (!authState.phone)
        return reply.status(400).send({ ok: false, error: 'Phone number missing.' });

      const suppliedMpin = mpin || authState.mpin || getDefaultMpin();
      if (!suppliedMpin) return reply.status(400).send({ ok: false, error: 'MPIN required.' });

      const cleanMpin = mpin ? String(mpin).trim() : '';

      const data = await nubraPost(
        '/verifyphoneotp',
        { phone: authState.phone, otp: String(otp).trim() },
        { 'x-temp-token': authState.tempToken },
      );

      const authToken = data.auth_token as string;
      if (!authToken) throw new Error('auth_token missing in response');

      authState.authToken = authToken;
      if (cleanMpin) authState.mpin = cleanMpin;
      authState.status = 'awaiting_mpin';
      saveSession();

      // Automatically execute verifypin block
      const finalMpin = cleanMpin || authState.mpin || '';
      const pinRes = await nubraPost(
        '/verifypin',
        { pin: finalMpin },
        { Authorization: `Bearer ${authToken}` },
      );
      const sessionToken = (pinRes.session_token ||
        (pinRes.data as Record<string, unknown>)?.token) as string;
      if (!sessionToken) throw new Error('session_token missing in response');

      authState.sessionToken = sessionToken;
      authState.status = 'authenticated';
      console.log('Authenticated. Session token acquired.');
      saveSession();
      connectNubraWs();
      try {
        broadcast({ type: 'auth_status', status: 'authenticated' });
      } catch {
        /* ws not ready */
      }

      return reply.send({ ok: true, message: 'Authenticated successfully.', authenticated: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: msg });
    }
  });

  fastify.post('/auth/verify-pin', async (_req, reply) => {
    try {
      const mpin = authState.mpin || getDefaultMpin();
      if (!mpin) return reply.status(500).send({ ok: false, error: 'MPIN not set' });
      if (!authState.authToken)
        return reply.status(400).send({ ok: false, error: 'Verify OTP first.' });

      const data = await nubraPost(
        '/verifypin',
        { pin: mpin },
        { Authorization: `Bearer ${authState.authToken}` },
      );
      const sessionToken = (data.session_token ||
        (data.data as Record<string, unknown>)?.token) as string;
      if (!sessionToken) throw new Error('session_token missing in response');

      authState.sessionToken = sessionToken;
      authState.status = 'authenticated';
      console.log('Authenticated. Session token acquired.');
      saveSession();
      connectNubraWs();
      try {
        broadcast({ type: 'auth_status', status: 'authenticated' });
      } catch {
        /* ws not ready */
      }
      return reply.send({ ok: true, message: 'Authenticated successfully.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: msg });
    }
  });

  fastify.get('/auth/status', async (_req, reply) => {
    return reply.send({
      status: authState.status,
      authenticated: authState.status === 'authenticated',
    });
  });

  fastify.post('/auth/logout', async (_req, reply) => {
    try {
      performLogout();
      return reply.send({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: msg });
    }
  });
}
