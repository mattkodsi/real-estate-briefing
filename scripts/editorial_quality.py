"""Publication safeguards, not a substitute for source-backed editorial review."""
import copy
import re
from datetime import datetime
from urllib.parse import urlparse
from content_quality import text_of


def validate_claims(story):
    body=text_of(story.get('content') or '')
    copy_text=' '.join(str(story.get(k) or '') for k in ('title','summary','quickSummary','pushBody'))
    # An observed ambiguous-name failure: never infer a famous company from a
    # shared brand token when the fetched source identifies another entity.
    if re.search(r'Berkshire Residential Investments',body,re.I) and re.search(r'Berkshire Hathaway|Warren Buffett',copy_text,re.I) and not re.search(r'Berkshire Hathaway|Warren Buffett',body,re.I):
        raise ValueError('Source/entity mismatch: Berkshire Residential Investments is not identified as Berkshire Hathaway in the article')
    for correction in story.get('identityCorrections') or []:
        if correction.get('incorrect') and re.search(r'(?<!\w)'+re.escape(correction['incorrect'])+r'(?!\w)',copy_text,re.I):
            raise ValueError('Previously corrected entity identity reintroduced')
    for field,evidence in (story.get('fieldEvidence') or {}).items():
        if field not in ('valueUsd','sizeSqft','units','capRate','noi') or not isinstance(evidence,dict):
            raise ValueError('Invalid field evidence')
        if story.get(field) != evidence.get('value'):
            raise ValueError('Source evidence disagrees with '+field)
        if not evidence.get('quote') or urlparse(str(evidence.get('url') or '')).scheme not in ('http','https'):
            raise ValueError('Missing source evidence for '+field)
    for receipt in story.get('sourceReceipts') or []:
        try:
            stamp=datetime.fromisoformat(receipt['receivedAt'].replace('Z','+00:00'))
            valid=stamp.tzinfo and receipt['provider']=='gmail' and re.fullmatch(r'[a-f0-9]{64}',receipt['messageHash']) and urlparse(receipt['url']).scheme in ('http','https')
        except (KeyError,TypeError,ValueError,AttributeError):valid=False
        urls={story.get('url'), *(c.get('url') for c in story.get('coverage',[]) if isinstance(c,dict))}
        if not valid or receipt.get('url') not in urls:raise ValueError('Invalid source receipt provenance')


def prepare_editorial(doc,current=None):
    result=copy.deepcopy(doc)
    before={s['id']:s for s in (current or {}).get('stories',[])}
    for s in result.get('stories',[]):
        prior=before.get(s['id'],{})
        # A fetched-source correction cannot be silently undone by an older
        # generator's headline-only rewrite. Source review must update evidence.
        for field in ('fieldEvidence','identityCorrections'):
            if prior.get(field) and field not in s:
                s[field]=copy.deepcopy(prior[field])
        if 'sourceReceipts' not in s and prior.get('sourceReceipts'):
            urls={s.get('url'), *(c.get('url') for c in s.get('coverage',[]) if isinstance(c,dict))}
            s['sourceReceipts']=[copy.deepcopy(r) for r in prior['sourceReceipts'] if r.get('url') in urls]
        changed=any(s.get(k)!=prior.get(k) for k in ('title','summary'))
        if changed and s.get('quickSummary')==prior.get('quickSummary'):
            s.pop('quickSummary',None)
        if not s.get('quickSummary'):
            # Whole copy only. Never manufacture an AI claim or cut a qualifier.
            s['quickSummary']=re.sub(r'\s+',' ',text_of(s.get('title') or s.get('summary') or '')).strip()
        if s.get('featured') and len(s['quickSummary']) > 110:
            raise ValueError('Featured stories need a complete quickSummary of at most 110 characters')
        validate_claims(s)
    return result
