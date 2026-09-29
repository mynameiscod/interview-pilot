import { describe, expect, it } from 'vitest';
import { deviceName } from './device-name';

describe('deviceName', () => {
  it('names common browsers and systems', () => {
    expect(
      deviceName(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome · Android');
    expect(
      deviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0',
      ),
    ).toBe('Edge · Windows');
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iOS');
  });

  it('returns null when nothing is known', () => {
    expect(deviceName(null)).toBeNull();
    expect(deviceName('curl/8.0')).toBeNull();
  });
});
