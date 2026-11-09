import { BrevoClient } from '@getbrevo/brevo';
import { ENV } from '../config/env';

// Initialize the modern Brevo client with your API key
const brevo = new BrevoClient({
  apiKey: ENV.BREVO_API_KEY,
});

/**
 * Sends a 6-digit verification OTP email to the user via Brevo's HTTPS REST API.
 */
export async function sendVerificationEmail(toEmail: string, otpCode: string): Promise<void> {
  try {
    const result = await brevo.transactionalEmails.sendTransacEmail({
      sender: { 
        name: 'Kronoscast Support', 
        email: 'no-reply@kronoscast.com' 
      },
      to: [{ email: toEmail }],
      subject: 'Your Kronoscast Verification Code',
      htmlContent: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #0b0f19; color: #f8fafc; border-radius: 8px;">
          <h2 style="color: #3b82f6; text-transform: uppercase; letter-spacing: 2px;">Kronoscast</h2>
          <p>Hello,</p>
          <p>Thank you for registering with Kronoscast. Please use the following 6-digit verification code to complete your account setup:</p>
          <div style="background-color: #1a2234; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 8px; color: #38bdf8; border-radius: 6px; margin: 20px 0;">
            ${otpCode}
          </div>
          <p>This code will expire in <strong>10 minutes</strong>.</p>
          <p style="color: #64748b; font-size: 12px; margin-top: 30px;">If you did not request this, please ignore this email.</p>
        </div>
      `,
    });

    console.log('Transactional email sent successfully:', result);
  } catch (error: any) {
    console.error('Failed to send Brevo transactional email:', error.body || error.message || error);
    throw new Error('Failed to send verification email.');
  }
}
