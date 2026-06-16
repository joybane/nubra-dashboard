import { useState } from 'react';

interface LoginOverlayProps {
  onAuthenticated: () => void;
}

export default function LoginOverlay({ onAuthenticated }: LoginOverlayProps) {
  const [step,    setStep]    = useState<1 | 2 | 3>(1);
  const [otp,     setOtp]     = useState('');
  const [status,  setStatus]  = useState<{ msg: string; type: 'info' | 'error' | 'success' } | null>(null);
  const [loading, setLoading] = useState(false);

  function showStatus(msg: string, type: 'info' | 'error' | 'success') {
    setStatus({ msg, type });
  }

  async function sendOtp() {
    setLoading(true);
    showStatus('Sending OTP…', 'info');
    try {
      const res  = await fetch('/auth/send-otp', { method: 'POST' });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };
      if (!data.ok) throw new Error(data.error);
      showStatus(data.message!, 'success');
      setStep(2);
      setTimeout(() => document.getElementById('otp-input')?.focus(), 100);
    } catch (err: unknown) {
      showStatus((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp() {
    if (!otp.trim()) { showStatus('Enter the OTP first.', 'error'); return; }
    setLoading(true);
    showStatus('Verifying OTP…', 'info');
    try {
      const res  = await fetch('/auth/verify-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ otp }),
      });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };
      if (!data.ok) throw new Error(data.error);
      showStatus('OTP verified. Verifying MPIN…', 'success');
      setStep(3);
      await verifyPin();
    } catch (err: unknown) {
      showStatus((err as Error).message, 'error');
      setStep(2);
    } finally {
      setLoading(false);
    }
  }

  async function verifyPin() {
    try {
      const res  = await fetch('/auth/verify-pin', { method: 'POST' });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };
      if (!data.ok) throw new Error(data.error);
      showStatus('Authenticated!', 'success');
      setTimeout(() => onAuthenticated(), 600);
    } catch (err: unknown) {
      showStatus((err as Error).message, 'error');
      setStep(2);
    }
  }

  const statusColors = {
    info:    'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    success: 'bg-green-500/10 text-green-400 border border-green-500/20',
    error:   'bg-red-500/10 text-red-400 border border-red-500/20',
  };

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-[1000]">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-9 w-[360px] flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-primary)]">
            Nubra <span className="text-[var(--accent)]">Dashboard</span>
          </h2>
          <p className="text-xs text-[var(--text-secondary)] mt-1">Sign in to continue</p>
        </div>

        {/* Step 1: Send OTP */}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-[var(--text-secondary)]">
              Click below to send an OTP to your registered mobile number.
            </p>
            <button
              onClick={sendOtp}
              disabled={loading}
              className="w-full py-2.5 px-4 bg-[var(--accent)] hover:bg-[var(--accent-dim)] text-white rounded-md font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Send OTP
            </button>
          </div>
        )}

        {/* Step 2: Enter OTP */}
        {step === 2 && (
          <div className="flex flex-col gap-3">
            <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
              Enter OTP
            </label>
            <input
              id="otp-input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="6-digit OTP"
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verifyOtp()}
              className="w-full px-3 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
            <button
              onClick={verifyOtp}
              disabled={loading}
              className="w-full py-2.5 px-4 bg-[var(--accent)] hover:bg-[var(--accent-dim)] text-white rounded-md font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              Verify OTP
            </button>
          </div>
        )}

        {/* Step 3: Auto MPIN */}
        {step === 3 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--text-secondary)]">
              Verifying MPIN from server configuration…
            </p>
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <span className="animate-spin inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full" />
              <span className="text-xs">Please wait…</span>
            </div>
          </div>
        )}

        {/* Status message */}
        {status && (
          <p className={`text-xs px-2.5 py-2 rounded-md ${statusColors[status.type]}`}>
            {status.msg}
          </p>
        )}
      </div>
    </div>
  );
}
