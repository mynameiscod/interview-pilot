export interface OtpSms {
  /** E.164, e.g. +919876543210. */
  to: string;
  code: string;
  ttlMinutes: number;
  /**
   * Full localised message, for providers that send free text (dev mailbox).
   * Template-based providers (MSG91/DLT) ignore it and send only the code.
   */
  text?: string;
}

export interface OtpSmsProvider {
  readonly name: string;
  sendOtp(message: OtpSms): Promise<{ providerMessageId?: string }>;
}
