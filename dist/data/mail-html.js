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
  /* No `class`. An email's own <style> blocks are stripped below, so its class
     names can only ever match the WORKSPACE's stylesheet — class="gate" or
     "toast" would dress a message up as part of the app. */
  var ALLOWED_ATTR = [
    'align','alt','bgcolor','border','cellpadding','cellspacing','color',
    'colspan','dir','face','height','href','rowspan','size','src','style','title',
    'valign','width'
  ];

  function safeHref(value) {
    var href = String(value || '').trim();
    /* Anything that is not plainly a web or mail link is dropped. A relative
       URL is meaningless in an email and is usually an attempt at something. */
    return /^(https?:|mailto:|tel:)/i.test(href) ? href : null;
  }

  /* An inline style is CSS, and DOMPurify does not read CSS. Left alone, an
     email's style="" can fetch a remote image — a tracking pixel that walks
     straight past "images blocked" — or pin itself over the workspace with
     position: fixed, which is all a fake "sign in again" screen needs.

     The first version parsed the CSS itself and was beaten by what the
     browser parses differently: escapes (u\rl), comments and backslashes that
     moved its declaration boundaries, image-set("…") with no url( at all. So
     the browser parses (cleanStyle, below) and this only judges the result —
     escapes resolved, comments gone, shorthands expanded to longhands — and
     judges it by allowlist: a property nobody listed is a property that goes. */
  var SAFE_PROPERTY = new RegExp('^(' + [
    'color', 'opacity', 'visibility', 'display', 'float', 'clear', 'direction', 'unicode-bidi',
    'vertical-align', 'white-space', 'word-break', 'word-spacing', 'overflow-wrap', 'letter-spacing',
    'line-height', 'box-sizing', 'table-layout', 'border-collapse', 'border-spacing', 'caption-side',
    'empty-cells', 'list-style-type', 'list-style-position',
    '(min-|max-)?(width|height)',
    'font(-family|-size|-style|-weight|-variant|-stretch)?',
    'text-(align|indent|transform|overflow|shadow|decoration(-line|-color|-style|-thickness)?)',
    '(margin|padding)(-(top|right|bottom|left))?',
    'border(-(top|right|bottom|left))?(-(width|style|color))?',
    'border(-(top|bottom)-(left|right))?-radius',
    'background-(color|image|position(-x|-y)?|size|repeat(-x|-y)?|clip|origin)'
  ].join('|') + ')$', 'i');
  /* Every CSS function that can fetch something, or reach outside the value. */
  var FETCHES = /(url|image-set|-webkit-image-set|image|cross-fade|element|src|paint|var|attr)\s*\(/i;
  var RUNS_CODE = /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior/i;
  /* The browser serialises a url as url("…"), always in double quotes. */
  var HTTPS_URL = /url\("https:\/\/[^"\\]*"\)/gi;

  function styleAllowed(property, value, options) {
    var name = String(property || '');
    var text = String(value || '').trim();
    if (!text || !SAFE_PROPERTY.test(name) || RUNS_CODE.test(text)) return false;
    if (!FETCHES.test(text)) return true;
    /* Images the reader asked to see may come through a plain https url() —
       and nothing else that fetches, even then. */
    if (!(options && options.showImages)) return false;
    return !FETCHES.test(text.replace(HTTPS_URL, ''));
  }

  function cleanStyle(style, options) {
    var parsed = document.createElement('div').style;
    parsed.cssText = style == null ? '' : String(style);
    var kept = [];
    for (var i = 0; i < parsed.length; i++) {
      var name = parsed[i];
      var value = parsed.getPropertyValue(name);
      if (styleAllowed(name, value, options)) kept.push(name + ': ' + value);
    }
    return kept.join('; ');
  }

  window.mailHtml = {
    styleAllowed: styleAllowed,
    cleanStyle: cleanStyle,

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

      host.querySelectorAll('[style]').forEach(function (el) {
        var kept = cleanStyle(el.getAttribute('style'), opts);
        if (kept) el.setAttribute('style', kept);
        else el.removeAttribute('style');
      });

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
