import { ApiClientError } from '@cbi/web-core';
import { describe, expect, it } from 'vitest';
import { initI18n } from '../../i18n';
import { paymentErrorMessage } from '../payments/payment-format';
import { inputErrorMessage, startErrorMessage } from './messages';

const notConfigured = () =>
  new ApiClientError(
    'NOT_CONFIGURED',
    'File storage is not set up yet. Please try again later.',
    503,
  );

describe('NOT_CONFIGURED messages', () => {
  it('explains a service that is not set up, in each language', async () => {
    const en = await initI18n({ detect: false, lng: 'en' });
    expect(inputErrorMessage(en.t, notConfigured())).toBe(
      'This service is not set up yet. Please try again later.',
    );
    expect(startErrorMessage(en.t, notConfigured())).toBe(
      'This service is not set up yet. Please try again later.',
    );

    const hi = await initI18n({ detect: false, lng: 'hi' });
    expect(inputErrorMessage(hi.t, notConfigured())).toBe(
      'यह सेवा अभी चालू नहीं की गई है। कृपया बाद में फिर से कोशिश करें।',
    );

    const te = await initI18n({ detect: false, lng: 'te' });
    expect(inputErrorMessage(te.t, notConfigured())).toBe(
      'ఈ సేవ ఇంకా సిద్ధం చేయబడలేదు. దయచేసి తర్వాత మళ్లీ ప్రయత్నించండి.',
    );
  });

  it('explains that online payments are not available', async () => {
    const en = await initI18n({ detect: false, lng: 'en' });
    expect(paymentErrorMessage(en.t, notConfigured())).toBe(
      'Online payments are not available right now. Please try again later.',
    );
    const te = await initI18n({ detect: false, lng: 'te' });
    expect(paymentErrorMessage(te.t, notConfigured())).toBe(
      'ఆన్‌లైన్ చెల్లింపులు ప్రస్తుతం అందుబాటులో లేవు. దయచేసి తర్వాత మళ్లీ ప్రయత్నించండి.',
    );
  });
});
