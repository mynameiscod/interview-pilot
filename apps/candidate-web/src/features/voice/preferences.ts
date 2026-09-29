import { useCallback, useState } from 'react';

const REVIEW_KEY = 'cbi.voice.reviewBeforeSending';

function read(): boolean {
  try {
    return localStorage.getItem(REVIEW_KEY) === '1';
  } catch {
    // Storage blocked: answers are sent after the grace window.
    return false;
  }
}

/**
 * Realtime voice: "let me review my answer before it is sent" (off by
 * default). Remembered in this browser only; nothing is sent to the server.
 */
export function useReviewBeforeSending(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  const update = useCallback((value: boolean) => {
    setOn(value);
    try {
      if (value) localStorage.setItem(REVIEW_KEY, '1');
      else localStorage.removeItem(REVIEW_KEY);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  }, []);
  return [on, update];
}
