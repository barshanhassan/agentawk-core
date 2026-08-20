/**
 * Shared branded shell for every transactional email — same wordmark, same
 * green accent (matches the app's own login/signup pages), same button/footer
 * style. Before this, every call site hand-rolled its own inline HTML with a
 * leftover indigo (#4f46e5) accent that never matched the actual brand.
 */
export function buildEmailHtml(opts: {
  heading: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  footerHtml?: string;
}): string {
  const { heading, bodyHtml, ctaText, ctaUrl, footerHtml } = opts;
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;padding:32px 24px;background:#ffffff">
      <div style="margin-bottom:28px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;padding-right:8px">
            <svg width="22" height="29" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M6 3 H34 A4 4 0 0 1 38 7 V17 A4 4 0 0 1 34 21 H6 A4 4 0 0 1 2 17 V7 A4 4 0 0 1 6 3 Z M11 12 a3.2 3.2 0 1 0 6.4 0 a3.2 3.2 0 1 0 -6.4 0 Z M22.6 12 a3.2 3.2 0 1 0 6.4 0 a3.2 3.2 0 1 0 -6.4 0 Z" fill="#25d366" />
              <rect x="4" y="25" width="32" height="5.5" rx="2" fill="#25d366" />
              <rect x="16.5" y="30" width="7" height="20" rx="2" fill="#25d366" />
            </svg>
          </td>
          <td style="vertical-align:middle">
            <span style="font-size:20px;font-weight:700;color:#0B1020;letter-spacing:-0.01em">agen<span style="color:#25d366">t</span><span style="color:#25d366">awk</span></span>
          </td>
        </tr></table>
      </div>
      <h2 style="color:#0B1020;font-size:20px;margin:0 0 12px">${heading}</h2>
      <div style="color:#33475b;font-size:14px;line-height:1.6">${bodyHtml}</div>
      ${ctaText && ctaUrl ? `
      <p style="text-align:center;margin:28px 0">
        <a href="${ctaUrl}" style="display:inline-block;background:#22B257;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">${ctaText}</a>
      </p>` : ''}
      ${footerHtml ? `<p style="color:#8a92a0;font-size:12px;margin-top:24px">${footerHtml}</p>` : ''}
      <div style="border-top:1px solid #eef0f4;margin-top:32px;padding-top:16px">
        <p style="color:#8a92a0;font-size:11px;margin:0">AGENTAWK &middot; WhatsApp, Messenger &amp; Instagram, answered by AI.</p>
      </div>
    </div>
  `;
}
