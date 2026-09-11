// Keep policy in sync with scripts/content_quality.py; parity is fixture-tested.
const gate = /(?:subscribe|sign in|log in|register|subscription required|subscriber.only|already a subscriber|purchase a subscription|unlock this article).{0,60}(?:read|continue|access|article|subscriber)|(?:to (?:read|continue)|remaining (?:article|content)).{0,50}(?:subscribe|sign in|subscription)|this (?:news )?(?:article|story|content) is (?:only )?(?:available|exclusive).{0,40}subscribers|exclusive news and analysis.{0,40}subscribers/i;
const chrome = /^(?:related (?:stories|articles)|recommended for you|most popular|trending|sign up|privacy policy|all rights reserved|cookie preferences|subscribe|sign in|log in)\b/i;
const textOf = value => String(value || '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|quot|lt|gt);/g, ' ');
const count = text => text.trim().split(/\s+/).filter(Boolean).length;
export function assessContent(value) {
  const text = textOf(value), words = count(text);
  if (!words) return {ready:false,status:'missing',reason:'empty_body',words:0};
  if (gate.test(text)) return {ready:false,status:'partial',reason:'subscriber_gate',words};
  const blocks = [...String(value || '').matchAll(/<(?:p|blockquote)\b[^>]*>(.*?)<\/(?:p|blockquote)>/gis)].map(m=>textOf(m[1]));
  const prose = blocks.filter(b=>count(b)>=12 && /[.!?](?:\s|$)/.test(b.trim()) && !chrome.test(b.trim())).reduce((n,b)=>n+count(b),0);
  const ready = prose >= 60 && prose >= words * .5;
  return {ready,status:ready?'ready':'partial',reason:ready?null:'insufficient_article_body',words};
}
