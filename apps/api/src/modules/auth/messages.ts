import type { EmailMessage } from '@cbi/provider-adapters';
import type { AdminRole, SessionAudience } from '@cbi/shared-types';

/**
 * Transactional email content. English only for now; localized templates
 * arrive with the notifications module. Never include anything beyond what
 * the recipient needs.
 */
export function otpEmail(
  to: string,
  code: string,
  ttlMinutes: number,
  audience: SessionAudience,
): EmailMessage {
  const product = audience === 'admin' ? 'CareerPilot Interview Admin' : 'CareerPilot Interview';
  const text = [
    `Your ${product} verification code is ${code}.`,
    '',
    `It expires in ${ttlMinutes} minutes. If you did not request it, you can ignore this email.`,
    'CodeBegun will never ask you to share this code.',
  ].join('\n');
  const html = `<p>Your ${product} verification code is:</p>
<p style="font-size:24px;font-weight:600;letter-spacing:4px">${code}</p>
<p>It expires in ${ttlMinutes} minutes. If you did not request it, you can ignore this email.</p>
<p>CodeBegun will never ask you to share this code.</p>`;
  return { to, subject: `${code} is your ${product} code`, text, html };
}

export function adminInviteEmail(to: string, adminUrl: string, roles: AdminRole[]): EmailMessage {
  const roleList = roles.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', ');
  return {
    to,
    subject: 'You have been given CareerPilot Interview admin access',
    text: [
      `You have been given admin access to CareerPilot Interview (${roleList}).`,
      '',
      `Sign in with this email address at ${adminUrl}`,
      '',
      'If you were not expecting this, please contact the CodeBegun team.',
    ].join('\n'),
  };
}
