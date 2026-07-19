import { useState } from 'react';

interface LoginOverlayProps {
  onAuthenticated: () => void;
}

export default function LoginOverlay({ onAuthenticated }: LoginOverlayProps) {
  const [step,    setStep]    = useState<1 | 2>(1);
  const [phone,   setPhone]   = useState(() => localStorage.getItem('saved_phone') || '');
  const [otp,     setOtp]     = useState('');
  const [mpin,    setMpin]    = useState('');
  const [status,  setStatus]  = useState<{ msg: string; type: 'info' | 'error' | 'success' } | null>(null);
  const [loading, setLoading] = useState(false);

  function showStatus(msg: string, type: 'info' | 'error' | 'success') {
    setStatus({ msg, type });
  }

  async function sendOtp() {
    if (!phone.trim()) { showStatus('Phone number is required.', 'error'); return; }
    setLoading(true);
    setOtp('');
    showStatus('Sending OTP...', 'info');
    try {
      localStorage.setItem('saved_phone', phone.trim());
      const res  = await fetch('/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
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
    if (!mpin.trim()) { showStatus('Enter your MPIN.', 'error'); return; }
    setLoading(true);
    showStatus('Verifying OTP and MPIN...', 'info');
    try {
      const res  = await fetch('/auth/verify-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ otp: otp.trim(), mpin: mpin.trim() }),
      });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };
      if (!data.ok) throw new Error(data.error);
      showStatus('Authenticated!', 'success');
      setTimeout(() => onAuthenticated(), 600);
    } catch (err: unknown) {
      showStatus((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function resumeSession() {
    setLoading(true);
    showStatus('Resuming session...', 'info');
    try {
      const res  = await fetch('/auth/verify-pin', { method: 'POST' });
      const data = await res.json() as { ok: boolean; message?: string; error?: string };
      if (!data.ok) throw new Error(data.error);
      showStatus('Authenticated!', 'success');
      setTimeout(() => onAuthenticated(), 500);
    } catch (err: unknown) {
      showStatus(`${(err as Error).message} - send OTP instead.`, 'error');
    } finally {
      setLoading(false);
    }
  }

  const statusColors = {
    info:    'bg-[rgba(59,130,246,0.1)] text-blue-400 border border-blue-500/20',
    success: 'bg-[rgba(34,197,94,0.1)] text-green-400 border border-green-500/20',
    error:   'bg-[rgba(239,68,68,0.1)] text-red-400 border border-red-500/20',
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

        {/* Step 1: Phone & Send OTP */}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
              Phone Number
            </label>
            <input
              type="text"
              placeholder="10-digit Phone Number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && phone.trim().length >= 10 && sendOtp()}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
            <button
              onClick={sendOtp}
              disabled={loading || phone.trim().length < 10}
              className="w-full py-2.5 px-4 bg-[var(--accent)] hover:bg-[var(--accent-dim)] text-white rounded-md font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Send OTP
            </button>
            <button
              onClick={resumeSession}
              disabled={loading}
              className="w-full py-2 px-4 bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--accent)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-md font-medium text-xs disabled:opacity-50 transition-colors"
            >
              Resume session (skip OTP)
            </button>
          </div>
        )}

        {/* Step 2: Enter OTP & MPIN */}
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
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
            <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
              Enter MPIN
            </label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              placeholder="4-digit MPIN"
              value={mpin}
              onChange={(e) => setMpin(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verifyOtp()}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
            />
            <button
              onClick={verifyOtp}
              disabled={loading || !otp.trim() || !mpin.trim()}
              className="w-full py-2.5 px-4 bg-[var(--accent)] hover:bg-[var(--accent-dim)] text-white rounded-md font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              Verify & Login
            </button>
            <button
              onClick={() => setStep(1)}
              disabled={loading}
              className="w-full py-2 px-4 bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--accent)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-md font-medium text-xs disabled:opacity-50 transition-colors"
            >
              Change Phone / Resend OTP
            </button>
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
