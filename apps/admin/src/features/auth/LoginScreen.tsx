import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';

import { useAdminApi, useSessionStore } from '../../app-context';
import { isOtpCode, portalOf, signInErrorMessage, toNepalPhone } from './login-rules';

/**
 * Two steps, like the mobile app: +977 number → SMS code. Super Admins open the dashboard, vendors
 * the Vendor Portal (Phase 19); every other account is turned away.
 */
export function LoginScreen() {
  const api = useAdminApi();
  const sessionStore = useSessionStore();
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (target: string) => api.sendOtp(target),
    onSuccess: (body) => {
      setPhone(body.phone);
      setCode('');
      setMessage(null);
    },
    onError: (error) => {
      setMessage(signInErrorMessage(error));
    },
  });

  const verify = useMutation({
    mutationFn: ({ target, otp }: { target: string; otp: string }) => api.verifyOtp(target, otp),
    onSuccess: (body, { target }) => {
      if (portalOf(body.user) === null) {
        // The tokens are simply dropped: every route of this app would answer 403 anyway.
        setMessage('This number does not belong to a Super Admin or a vendor.');
        setPhone(null);
        return;
      }
      sessionStore.getState().setSession({
        phone: target,
        user: body.user,
        accessToken: body.access_token,
        // A vendor's refresh token comes in the body; a Super Admin's is the HttpOnly cookie.
        ...('refresh_token' in body ? { refreshToken: body.refresh_token } : {}),
      });
    },
    onError: (error) => {
      setMessage(signInErrorMessage(error));
    },
  });

  const onSendCode = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = toNepalPhone(number);
    if (target === null) {
      setMessage('Enter a valid Nepal mobile number (98XXXXXXXX).');
      return;
    }
    send.mutate(target);
  };

  const onVerify = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phone === null) return;
    if (!isOtpCode(code)) {
      setMessage('The code has 6 digits.');
      return;
    }
    verify.mutate({ target: phone, otp: code.trim() });
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1>Hamro Pasal</h1>
        <p className="muted small">Super Admin dashboard and Vendor Portal</p>
        {phone === null ? (
          <form onSubmit={onSendCode}>
            <label htmlFor="phone">Mobile number</label>
            <div className="phone-field">
              <span className="prefix">+977</span>
              <input
                id="phone"
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder="98XXXXXXXX"
                value={number}
                onChange={(event) => {
                  setNumber(event.target.value);
                }}
              />
            </div>
            <button type="submit" className="button primary" disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={onVerify}>
            <label htmlFor="code">Code sent to {phone}</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, ''));
              }}
            />
            <button type="submit" className="button primary" disabled={verify.isPending}>
              {verify.isPending ? 'Checking…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setPhone(null);
                setMessage(null);
              }}
            >
              Change number
            </button>
          </form>
        )}
        {message !== null && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
        <p className="muted small">
          Super Admins stay signed in on this browser for 7 days, or until they sign out. Vendors
          sign in again after reloading the page.
        </p>
      </div>
    </main>
  );
}
