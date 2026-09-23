export interface OtpSms {
  /** E.164, e.g. +919876543210. */
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface OtpSmsProvider {
  readonly name: string;
  sendOtp(message: OtpSms): Promise<{ providerMessageId?: string }>;
}
