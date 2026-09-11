import { authorized } from './audit-auth.mjs';
export function validateCapture(body, requireCookie = true) {
 const domain=String(body.domain || '').trim().toLowerCase().replace(/^www\./,'');
 if (!['therealdeal.com','inman.com','bisnow.com'].includes(domain)) throw new Error('Unsupported publisher');
 const cookie=String(body.cookie || '').trim();
 if(requireCookie && (cookie.length<20 || cookie.length>32768 || !cookie.includes('=') || /[\r\n\0]/.test(cookie))) throw new Error('Invalid cookie header');
 return {domain,cookie};
}
export async function captureAuthorized(req, secret, body, consumeTicket) {
 if(authorized(req,secret)) return true;
 if(typeof body.captureToken!=='string' || !/^[a-f0-9]{64}$/.test(body.captureToken)) return false;
 return await consumeTicket(body.captureToken);
}
export async function hashToken(token) {
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
