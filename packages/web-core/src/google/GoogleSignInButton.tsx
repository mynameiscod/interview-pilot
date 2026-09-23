import { useEffect, useRef, useState } from 'react';

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    ux_mode?: 'popup';
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      theme?: string;
      size?: string;
      text?: string;
      shape?: string;
      width?: number;
      locale?: string;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
let loader: Promise<void> | null = null;

/** Loads Google Identity Services once, only when a Google button is shown. */
function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  loader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loader = null;
      reject(new Error('Google sign-in could not be loaded'));
    };
    document.head.appendChild(script);
  });
  return loader;
}

export interface GoogleSignInButtonProps {
  clientId: string;
  /** Receives the ID token to send to the API. */
  onCredential: (idToken: string) => void;
  locale?: string;
  /** Shown if the Google script is blocked (e.g. by an extension or network). */
  unavailableMessage: string;
}

/**
 * Renders Google's own button (required by Google's branding rules) using the
 * ID-token flow: no client secret, nothing stored by the browser.
 */
export function GoogleSignInButton({
  clientId,
  onCredential,
  locale,
  unavailableMessage,
}: GoogleSignInButtonProps) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    callback.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    let cancelled = false;
    loadGis()
      .then(() => {
        if (cancelled || !container.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => callback.current(response.credential),
          ux_mode: 'popup',
        });
        window.google.accounts.id.renderButton(container.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: Math.min(container.current.offsetWidth || 320, 400),
          locale,
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, locale]);

  if (failed) {
    return (
      <p className="small cb-text-secondary mb-0" role="status">
        {unavailableMessage}
      </p>
    );
  }
  return <div ref={container} className="w-100 d-flex justify-content-center" />;
}
