/* Keep keyboard and assistive-technology focus inside the topmost app overlay. */
(function(root) {
  function setupOverlayFocus(doc, close) {
    const prior = new Map();
    let active = null;
    const candidates = () => [...doc.querySelectorAll('#reader, #profiles, #sheet, #lightbox, #sharebox, .reconnect-ov')]
      .filter(el => !el.hidden && el.isConnected)
      .sort((a,b) => (parseInt(getComputedStyle(a).zIndex)||0) - (parseInt(getComputedStyle(b).zIndex)||0));
    const focusables = el => [...el.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')]
      .filter(x => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length && !x.closest('[hidden]'));
    function sync() {
      const open = candidates(), top = open.at(-1) || null;
      for (const child of doc.body.children) {
        if (['SCRIPT','STYLE'].includes(child.tagName) || child.id === 'toast') continue;
        const inert = !!top && child !== top && !child.contains(top);
        if (child.inert !== inert) child.inert = inert;
      }
      if (top === active) return;
      const previous = active; active = top;
      if (top) {
        if (!prior.has(top)) prior.set(top, doc.activeElement);
        top.setAttribute('role','dialog'); top.setAttribute('aria-modal','true'); top.tabIndex = -1;
        if (!top.hasAttribute('aria-label') && !top.hasAttribute('aria-labelledby')) top.setAttribute('aria-label', top.id === 'profiles' ? 'Choose reader' : 'Preview');
        if (!top.contains(doc.activeElement)) (focusables(top)[0] || top).focus({preventScroll:true});
      } else if (previous) {
        const target = prior.get(previous);
        if (target?.isConnected && !target.closest('[hidden]')) target.focus({preventScroll:true});
      }
      for (const el of prior.keys()) if (!open.includes(el)) {
        const target = prior.get(el); prior.delete(el);
        if (top && target?.isConnected && top.contains(target)) target.focus({preventScroll:true});
      }
    }
    doc.addEventListener('keydown', e => {
      if (!active) return;
      if (e.key === 'Escape' && close(active)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.key !== 'Tab') return;
      const nodes = focusables(active), first = nodes[0], last = nodes.at(-1);
      if (!nodes.length) { e.preventDefault(); active.focus(); }
      else if (e.shiftKey && (doc.activeElement === first || !active.contains(doc.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (doc.activeElement === last || !active.contains(doc.activeElement))) { e.preventDefault(); first.focus(); }
    }, true);
    const observer = new MutationObserver(sync);
    observer.observe(doc.body, {subtree:true, childList:true, attributes:true, attributeFilter:['hidden','class']});
    sync();
    return () => observer.disconnect();
  }
  root.setupOverlayFocus = setupOverlayFocus;
})(globalThis);
