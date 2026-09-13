/* mail-html.js — rendering an email body safely.
 *
 * An email body is the most hostile HTML a workspace ever handles: written by
 * anyone, full of tracking, and quite happy to contain a <script> or an
 * onerror= if you let it. So it goes through DOMPurify, and then through a
 * second pass that deals with the things a sanitiser does not consider its
 * problem.
 *
 * WHAT THE SECOND PASS DOES, AND WHY:
 *
 *   Remote images are blocked by default. A 1x1 GIF on a remote host is how
 *   mail senders learn you opened it, and when, and roughly where from.
 *   Outlook and Gmail both block them for the same reason. Each blocked image
 *   keeps its src in data-blocked-src, and one click shows all of them — a
 *   decision the reader makes per message rather than a setting they forget.
 *
 *   Links open in a new tab with rel="noopener noreferrer": without noopener a
 *   linked page can reach back through window.opener, and without noreferrer it
 *   learns where the click came from.
 *
 *   javascript: and data: URLs are stripped from hrefs. DOMPurify catches most,
 *   but the belt-and-braces here is cheap and the failure is xss.
 */
(function () {
  'use strict';

  var ALLOWED_TAGS = [
    'a','b','blockquote','br','caption','code','div','em','h1','h2','h3','h4','h5','h6',
    'hr','i','img','li','ol','p','pre','q','small','span','strong','sub','sup',
    'table','tbody','td','tfoot','th','thead','tr','u','ul','center','font'
  ];
  var ALLOWED_ATTR = [
    'align','alt','bgcolor','border','cellpadding','cellspacing','class','color',
    'colspan','dir','face','height','href','rowspan','size','src','style','title',
    'valign','width'
  ];

  function safeHref(value) {
    var href = String(value || '').trim();
    /* Anything that is not plainly a web or mail link is dropped. A relative
       URL is meaningless in an email and is usually an attempt at something. */
    return /^(https?:|mailto:|tel:)/i.test(href) ? href : null;
  }

  window.mailHtml = {
    /* Returns { html, blockedImages } — the caller decides how to offer the
       "show images" affordance, and how many were hidden. */
    render: function (rawHtml, options) {
      var opts = options || {};
      if (!window.DOMPurify) {
        console.error('[workspace] DOMPurify missing — refusing to render email HTML.');
        return { html: '', blockedImages: 0, unavailable: true };
      }

      var clean = window.DOMPurify.sanitize(String(rawHtml || ''), {
        ALLOWED_TAGS: ALLOWED_TAGS,
        ALLOWED_ATTR: ALLOWED_ATTR,
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
        FORBID_ATTR: ['srcset', 'formaction', 'xlink:href'],
        ALLOW_DATA_ATTR: false,
        /* Keep the text of anything removed: a stripped <style> block should
           not take the paragraph after it with it. */
        KEEP_CONTENT: true,
        RETURN_DOM_FRAGMENT: true
      });

      var host = document.createElement('div');
      host.appendChild(clean);

      var blocked = 0;
      host.querySelectorAll('img').forEach(function (img) {
        var src = String(img.getAttribute('src') || '');
        /* cid: images are inline attachments we have not fetched; there is
           nothing to show, so they go entirely rather than leaving a broken
           icon. */
        if (/^cid:/i.test(src)) { img.remove(); return; }
        /* A data: image is self-contained — no request, nothing to leak. */
        if (/^data:image\//i.test(src)) return;
        if (!/^https?:/i.test(src)) { img.remove(); return; }

        if (!opts.showImages) {
          img.setAttribute('data-blocked-src', src);
          img.removeAttribute('src');
          img.setAttribute('alt', img.getAttribute('alt') || 'Image not shown');
          img.classList.add('mail-image-blocked');
          blocked++;
        }
      });

      host.querySelectorAll('a').forEach(function (a) {
        var href = safeHref(a.getAttribute('href'));
        if (!href) { a.removeAttribute('href'); return; }
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });

      /* Email loves a fixed pixel width. Left alone, a 600px table forces the
         whole reader to scroll sideways. */
      host.querySelectorAll('table, td, img').forEach(function (el) {
        if (el.hasAttribute('width')) el.style.maxWidth = '100%';
      });

      return { html: host.innerHTML, blockedImages: blocked };
    }
  };
})();
