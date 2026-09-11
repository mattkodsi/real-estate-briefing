"""Conservative reader-body checks. Keep thresholds in sync with content-quality.mjs."""
import html
import re

GATE = re.compile(r"(?:subscribe|sign in|log in|register|subscription required|subscriber.only|already a subscriber|purchase a subscription|unlock this article).{0,60}(?:read|continue|access|article|subscriber)|(?:to (?:read|continue)|remaining (?:article|content)).{0,50}(?:subscribe|sign in|subscription)|this (?:news )?(?:article|story|content) is (?:only )?(?:available|exclusive).{0,40}subscribers|exclusive news and analysis.{0,40}subscribers", re.I)
CHROME = re.compile(r"^(?:related (?:stories|articles)|recommended for you|most popular|trending|sign up|privacy policy|all rights reserved|cookie preferences|subscribe|sign in|log in)\b", re.I)

def text_of(value):
    return html.unescape(re.sub(r"<[^>]+>", " ", value or ""))

def assess_content(value):
    text = text_of(value)
    words = len(text.split())
    if not words:
        return {"ready": False, "status": "missing", "reason": "empty_body", "words": 0}
    if GATE.search(text):
        return {"ready": False, "status": "partial", "reason": "subscriber_gate", "words": words}
    blocks = [text_of(m) for m in re.findall(r"<(?:p|blockquote)\b[^>]*>(.*?)</(?:p|blockquote)>", value or "", re.I | re.S)]
    narrative = [b for b in blocks if len(b.split()) >= 12 and re.search(r"[.!?](?:\s|$)", b.strip()) and not CHROME.search(b.strip())]
    prose = sum(len(b.split()) for b in narrative)
    # Short complete dispatches qualify; headings and navigation cannot supply length.
    ready = prose >= 60 and prose >= words * .5
    return {"ready": ready, "status": "ready" if ready else "partial", "reason": None if ready else "insufficient_article_body", "words": words}
